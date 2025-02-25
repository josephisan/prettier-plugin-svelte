import { generate } from 'astring';
import { Doc, doc, FastPath, ParserOptions } from 'prettier';
import { formattableAttributes, selfClosingTags } from '../lib/elements';
import { extractAttributes } from '../lib/extractAttributes';
import { getText } from '../lib/getText';
import { hasSnippedContent, unsnipContent } from '../lib/snipTagContent';
import { isBracketSameLine, parseSortOrder, SortOrderPart } from '../options';
import { isEmptyDoc, isLine, trim, trimRight } from './doc-helpers';
import {
    flatten,
    getAttributeLine,
    groupConcat,
    isASTNode,
    isPreTagContent,
    printWithPrependedAttributeLine,
    replaceEndOfLineWith,
} from './helpers';
import {
    checkWhitespaceAtEndOfSvelteBlock,
    checkWhitespaceAtStartOfSvelteBlock,
    doesEmbedStartAfterNode,
    endsWithLinebreak,
    getUnencodedText,
    isBlockElement,
    isEmptyTextNode,
    isIgnoreDirective,
    isInlineElement,
    isInsideQuotedAttribute,
    isLoneMustacheTag,
    isNodeSupportedLanguage,
    isOrCanBeConvertedToShorthand,
    isTextNodeEndingWithLinebreak,
    isTextNodeEndingWithWhitespace,
    isTextNodeStartingWithLinebreak,
    isTextNodeStartingWithWhitespace,
    printRaw,
    shouldHugEnd,
    shouldHugStart,
    startsWithLinebreak,
    trimChildren,
    trimTextNodeLeft,
    trimTextNodeRight,
    canOmitSoftlineBeforeClosingTag,
    getNextNode,
    isIgnoreStartDirective,
    isIgnoreEndDirective,
    isNodeTopLevelHTML,
    getChildren,
} from './node-helpers';
import {
    ASTNode,
    AttributeNode,
    CommentInfo,
    CommentNode,
    IfBlockNode,
    Node,
    OptionsNode,
    StyleDirectiveNode,
    TextNode,
} from './nodes';

const {
    concat,
    join,
    line,
    group,
    indent,
    dedent,
    softline,
    hardline,
    fill,
    breakParent,
    literalline,
} = doc.builders;

export type PrintFn = (path: FastPath) => Doc;

declare module 'prettier' {
    export namespace doc {
        namespace builders {
            interface Line {
                keepIfLonely?: boolean;
            }
        }
    }
}

export function hasPragma(text: string) {
    return /^\s*<!--\s*@(format|prettier)\W/.test(text);
}

let ignoreNext = false;
let ignoreRange = false;
let svelteOptionsDoc: Doc | undefined;

export function print(path: FastPath, options: ParserOptions, print: PrintFn): Doc {
    const bracketSameLine = isBracketSameLine(options);

    const n = path.getValue();
    if (!n) {
        return '';
    }

    if (isASTNode(n)) {
        assignCommentsToNodes(n);
        return printTopLevelParts(n, options, path, print);
    }

    const [open, close] = options.svelteStrictMode ? ['"{', '}"'] : ['{', '}'];
    const printJsExpression = () => [
        open,
        printJS(path, print, options.svelteStrictMode, false, false, 'expression'),
        close,
    ];
    const node = n as Node;

    if (
        (ignoreNext || (ignoreRange && !isIgnoreEndDirective(node))) &&
        (node.type !== 'Text' || !isEmptyTextNode(node))
    ) {
        if (ignoreNext) {
            ignoreNext = false;
        }
        return concat(
            flatten(
                options.originalText
                    .slice(options.locStart(node), options.locEnd(node))
                    .split('\n')
                    .map((o, i) => (i == 0 ? [o] : [literalline, o])),
            ),
        );
    }

    switch (node.type) {
        case 'Fragment':
            const children = node.children;

            if (children.length === 0 || children.every(isEmptyTextNode)) {
                return '';
            }
            if (!isPreTagContent(path)) {
                trimChildren(node.children, path);
                const output = trim(
                    [printChildren(path, print, options)],
                    (n) =>
                        isLine(n) ||
                        (typeof n === 'string' && n.trim() === '') ||
                        // Because printChildren may append this at the end and
                        // may hide other lines before it
                        n === breakParent,
                );
                if (output.every((doc) => isEmptyDoc(doc))) {
                    return '';
                }
                return groupConcat([...output, hardline]);
            } else {
                return groupConcat(path.map(print, 'children'));
            }
        case 'Text':
            if (!isPreTagContent(path)) {
                if (isEmptyTextNode(node)) {
                    const hasWhiteSpace =
                        getUnencodedText(node).trim().length < getUnencodedText(node).length;
                    const hasOneOrMoreNewlines = /\n/.test(getUnencodedText(node));
                    const hasTwoOrMoreNewlines = /\n\r?\s*\n\r?/.test(getUnencodedText(node));
                    if (hasTwoOrMoreNewlines) {
                        return concat([hardline, hardline]);
                    }
                    if (hasOneOrMoreNewlines) {
                        return hardline;
                    }
                    if (hasWhiteSpace) {
                        return line;
                    }
                    return '';
                }

                /**
                 * For non-empty text nodes each sequence of non-whitespace characters (effectively,
                 * each "word") is joined by a single `line`, which will be rendered as a single space
                 * until this node's current line is out of room, at which `fill` will break at the
                 * most convenient instance of `line`.
                 */
                return fill(splitTextToDocs(node));
            } else {
                let rawText = getUnencodedText(node);
                const parent = path.getParentNode();
                if (parent.type === 'Attribute') {
                    // Direct child of attribute value -> add literallines at end of lines
                    // so that other things don't break in unexpected places
                    if (parent.name === 'class' && path.getParentNode(1).type === 'Element') {
                        // Special treatment for class attribute on html elements. Prettier
                        // will force everything into one line, we deviate from that and preserve lines.
                        rawText = rawText.replace(
                            /([^ \t\n])(([ \t]+$)|([ \t]+(\r?\n))|[ \t]+)/g,
                            // Remove trailing whitespace in lines with non-whitespace characters
                            // except at the end of the string
                            (
                                match,
                                characterBeforeWhitespace,
                                _,
                                isEndOfString,
                                isEndOfLine,
                                endOfLine,
                            ) =>
                                isEndOfString
                                    ? match
                                    : characterBeforeWhitespace + (isEndOfLine ? endOfLine : ' '),
                        );
                        // Shrink trailing whitespace in case it's followed by a mustache tag
                        // and remove it completely if it's at the end of the string, but not
                        // if it's on its own line
                        rawText = rawText.replace(
                            /([^ \t\n])[ \t]+$/,
                            parent.value.indexOf(node) === parent.value.length - 1 ? '$1' : '$1 ',
                        );
                    }
                    return concat(replaceEndOfLineWith(rawText, literalline));
                }
                return rawText;
            }
        case 'Element':
        case 'InlineComponent':
        case 'Slot':
        case 'SlotTemplate':
        case 'Window':
        case 'Head':
        case 'Title': {
            const isSupportedLanguage = !(
                node.name === 'template' && !isNodeSupportedLanguage(node)
            );
            const isEmpty = node.children.every((child) => isEmptyTextNode(child));
            const isDoctypeTag = node.name.toUpperCase() === '!DOCTYPE';

            const isSelfClosingTag =
                isEmpty &&
                (!options.svelteStrictMode ||
                    node.type !== 'Element' ||
                    selfClosingTags.indexOf(node.name) !== -1 ||
                    isDoctypeTag);

            // Order important: print attributes first
            const attributes = path.map(
                printWithPrependedAttributeLine(node, options, print),
                'attributes',
            );
            const attributeLine = getAttributeLine(node, options);
            const possibleThisBinding =
                node.type === 'InlineComponent' && node.expression
                    ? concat([attributeLine, 'this=', ...printJsExpression()])
                    : node.type === 'Element' && node.tag
                    ? concat([
                          attributeLine,
                          'this=',
                          ...(typeof node.tag === 'string'
                              ? [`"${node.tag}"`]
                              : [
                                    open,
                                    printJS(
                                        path,
                                        print,
                                        options.svelteStrictMode,
                                        false,
                                        false,
                                        'tag',
                                    ),
                                    close,
                                ]),
                      ])
                    : '';

            if (isSelfClosingTag) {
                return groupConcat([
                    '<',
                    node.name,

                    indent(
                        groupConcat([
                            possibleThisBinding,
                            ...attributes,
                            bracketSameLine || isDoctypeTag ? '' : dedent(line),
                        ]),
                    ),

                    ...[bracketSameLine && !isDoctypeTag ? ' ' : '', `${isDoctypeTag ? '' : '/'}>`],
                ]);
            }

            const children = node.children;
            const firstChild = children[0];
            const lastChild = children[children.length - 1];

            // Is a function which is invoked later because printChildren will manipulate child nodes
            // which would wrongfully change the other checks about hugging etc done beforehand
            let body: () => Doc;

            const hugStart = shouldHugStart(node, isSupportedLanguage, options);
            const hugEnd = shouldHugEnd(node, isSupportedLanguage, options);

            if (isEmpty) {
                body =
                    isInlineElement(path, options, node) &&
                    node.children.length &&
                    isTextNodeStartingWithWhitespace(node.children[0]) &&
                    !isPreTagContent(path)
                        ? () => line
                        : () => (bracketSameLine ? softline : '');
            } else if (isPreTagContent(path)) {
                body = () => printPre(node, options.originalText, path, print);
            } else if (!isSupportedLanguage) {
                body = () => printRaw(node, options.originalText, true);
            } else if (isInlineElement(path, options, node) && !isPreTagContent(path)) {
                body = () => printChildren(path, print, options);
            } else {
                body = () => printChildren(path, print, options);
            }

            const openingTag = [
                '<',
                node.name,

                indent(
                    groupConcat([
                        possibleThisBinding,
                        ...attributes,
                        hugStart
                            ? ''
                            : !bracketSameLine && !isPreTagContent(path)
                            ? dedent(softline)
                            : '',
                    ]),
                ),
            ];

            if (!isSupportedLanguage && !isEmpty) {
                // Format template tags so that there's a hardline but no indention.
                // That way the `lang="X"` and the closing `>` of the start tag stay in one line
                // which is the 99% use case.
                return groupConcat([
                    ...openingTag,
                    '>',
                    groupConcat([hardline, body(), hardline]),
                    `</${node.name}>`,
                ]);
            }

            if (hugStart && hugEnd) {
                const huggedContent = concat([
                    softline,
                    groupConcat(['>', body(), `</${node.name}`]),
                ]);
                const omitSoftlineBeforeClosingTag =
                    (isEmpty && !bracketSameLine) ||
                    canOmitSoftlineBeforeClosingTag(node, path, options);
                return groupConcat([
                    ...openingTag,
                    isEmpty ? group(huggedContent) : group(indent(huggedContent)),
                    omitSoftlineBeforeClosingTag ? '' : softline,
                    '>',
                ]);
            }

            // No hugging of content means it's either a block element and/or there's whitespace at the start/end
            let noHugSeparatorStart: Doc = softline;
            let noHugSeparatorEnd: Doc = softline;
            if (isPreTagContent(path)) {
                noHugSeparatorStart = '';
                noHugSeparatorEnd = '';
            } else {
                let didSetEndSeparator = false;

                if (!hugStart && firstChild && firstChild.type === 'Text') {
                    if (
                        isTextNodeStartingWithLinebreak(firstChild) &&
                        firstChild !== lastChild &&
                        (!isInlineElement(path, options, node) ||
                            isTextNodeEndingWithWhitespace(lastChild))
                    ) {
                        noHugSeparatorStart = hardline;
                        noHugSeparatorEnd = hardline;
                        didSetEndSeparator = true;
                    } else if (isInlineElement(path, options, node)) {
                        noHugSeparatorStart = line;
                    }
                    trimTextNodeLeft(firstChild);
                }
                if (!hugEnd && lastChild && lastChild.type === 'Text') {
                    if (isInlineElement(path, options, node) && !didSetEndSeparator) {
                        noHugSeparatorEnd = line;
                    }
                    trimTextNodeRight(lastChild);
                }
            }

            if (hugStart) {
                return groupConcat([
                    ...openingTag,
                    indent(concat([softline, groupConcat(['>', body()])])),
                    noHugSeparatorEnd,
                    `</${node.name}>`,
                ]);
            }

            if (hugEnd) {
                return groupConcat([
                    ...openingTag,
                    '>',
                    indent(concat([noHugSeparatorStart, groupConcat([body(), `</${node.name}`])])),
                    canOmitSoftlineBeforeClosingTag(node, path, options) ? '' : softline,
                    '>',
                ]);
            }

            if (isEmpty) {
                return groupConcat([...openingTag, '>', body(), `</${node.name}>`]);
            }

            return groupConcat([
                ...openingTag,
                '>',
                indent(concat([noHugSeparatorStart, body()])),
                noHugSeparatorEnd,
                `</${node.name}>`,
            ]);
        }
        case 'Options':
            if (options.svelteSortOrder !== 'none') {
                throw new Error('Options tags should have been handled by prepareChildren');
            }
        // else fall through to Body
        case 'Body':
            return groupConcat([
                '<',
                node.name,
                indent(
                    groupConcat([
                        ...path.map(
                            printWithPrependedAttributeLine(node, options, print),
                            'attributes',
                        ),
                        bracketSameLine ? '' : dedent(line),
                    ]),
                ),
                ...[bracketSameLine ? ' ' : '', '/>'],
            ]);
        case 'Document':
            return groupConcat([
                '<',
                node.name,
                indent(
                    groupConcat([
                        ...path.map(
                            printWithPrependedAttributeLine(node, options, print),
                            'attributes',
                        ),
                        bracketSameLine ? '' : dedent(line),
                    ]),
                ),
                ...[bracketSameLine ? ' ' : '', '/>'],
            ]);
        case 'Identifier':
            return node.name;
        case 'AttributeShorthand': {
            return (node.expression as any).name;
        }
        case 'Attribute': {
            if (isOrCanBeConvertedToShorthand(node)) {
                if (options.svelteStrictMode) {
                    return concat([node.name, '="{', node.name, '}"']);
                } else if (options.svelteAllowShorthand) {
                    return concat(['{', node.name, '}']);
                } else {
                    return concat([node.name, '={', node.name, '}']);
                }
            } else {
                if (node.value === true) {
                    return concat([node.name]);
                }

                const quotes = !isLoneMustacheTag(node.value) || options.svelteStrictMode;
                const attrNodeValue = printAttributeNodeValue(path, print, quotes, node);
                if (quotes) {
                    return concat([node.name, '=', '"', attrNodeValue, '"']);
                } else {
                    return concat([node.name, '=', attrNodeValue]);
                }
            }
        }
        case 'MustacheTag':
            return concat([
                '{',
                printJS(
                    path,
                    print,
                    isInsideQuotedAttribute(path, options),
                    false,
                    false,
                    'expression',
                ),
                '}',
            ]);
        case 'IfBlock': {
            const def: Doc[] = [
                '{#if ',
                printSvelteBlockJS(path, print, 'expression'),
                '}',
                printSvelteBlockChildren(path, print, options),
            ];

            if (node.else) {
                def.push(path.call(print, 'else'));
            }

            def.push('{/if}');

            return concat([groupConcat(def), breakParent]);
        }
        case 'ElseBlock': {
            // Else if
            const parent = path.getParentNode() as Node;

            if (
                node.children.length === 1 &&
                node.children[0].type === 'IfBlock' &&
                parent.type !== 'EachBlock'
            ) {
                const ifNode = node.children[0] as IfBlockNode;
                const def: Doc[] = [
                    '{:else if ',
                    path.map(
                        (ifPath) => printSvelteBlockJS(ifPath, print, 'expression'),
                        'children',
                    )[0],
                    '}',
                    path.map(
                        (ifPath) => printSvelteBlockChildren(ifPath, print, options),
                        'children',
                    )[0],
                ];

                if (ifNode.else) {
                    def.push(path.map((ifPath) => ifPath.call(print, 'else'), 'children')[0]);
                }
                return concat(def);
            }

            return concat(['{:else}', printSvelteBlockChildren(path, print, options)]);
        }
        case 'EachBlock': {
            const def: Doc[] = [
                '{#each ',
                printSvelteBlockJS(path, print, 'expression'),
                ' as',
                expandNode(node.context),
            ];

            if (node.index) {
                def.push(', ', node.index);
            }

            if (node.key) {
                def.push(' (', printSvelteBlockJS(path, print, 'key'), ')');
            }

            def.push('}', printSvelteBlockChildren(path, print, options));

            if (node.else) {
                def.push(path.call(print, 'else'));
            }

            def.push('{/each}');

            return concat([groupConcat(def), breakParent]);
        }
        case 'AwaitBlock': {
            const hasPendingBlock = node.pending.children.some((n) => !isEmptyTextNode(n));
            const hasThenBlock = node.then.children.some((n) => !isEmptyTextNode(n));
            const hasCatchBlock = node.catch.children.some((n) => !isEmptyTextNode(n));

            let block = [];

            if (!hasPendingBlock && hasThenBlock) {
                block.push(
                    groupConcat([
                        '{#await ',
                        printSvelteBlockJS(path, print, 'expression'),
                        ' then',
                        expandNode(node.value),
                        '}',
                    ]),
                    path.call(print, 'then'),
                );
            } else if (!hasPendingBlock && hasCatchBlock) {
                block.push(
                    groupConcat([
                        '{#await ',
                        printSvelteBlockJS(path, print, 'expression'),
                        ' catch',
                        expandNode(node.error),
                        '}',
                    ]),
                    path.call(print, 'catch'),
                );
            } else {
                block.push(
                    groupConcat(['{#await ', printSvelteBlockJS(path, print, 'expression'), '}']),
                );

                if (hasPendingBlock) {
                    block.push(path.call(print, 'pending'));
                }

                if (hasThenBlock) {
                    block.push(
                        groupConcat(['{:then', expandNode(node.value), '}']),
                        path.call(print, 'then'),
                    );
                }
            }

            if ((hasPendingBlock || hasThenBlock) && hasCatchBlock) {
                block.push(
                    groupConcat(['{:catch', expandNode(node.error), '}']),
                    path.call(print, 'catch'),
                );
            }

            block.push('{/await}');

            return groupConcat(block);
        }
        case 'KeyBlock': {
            const def: Doc[] = [
                '{#key ',
                printSvelteBlockJS(path, print, 'expression'),
                '}',
                printSvelteBlockChildren(path, print, options),
            ];

            def.push('{/key}');

            return concat([groupConcat(def), breakParent]);
        }
        case 'ThenBlock':
        case 'PendingBlock':
        case 'CatchBlock':
            return printSvelteBlockChildren(path, print, options);
        case 'EventHandler':
            return concat([
                'on:',
                node.name,
                node.modifiers && node.modifiers.length
                    ? concat(['|', join('|', node.modifiers)])
                    : '',
                node.expression ? concat(['=', ...printJsExpression()]) : '',
            ]);
        case 'Binding':
            return concat([
                'bind:',
                node.name,
                node.expression.type === 'Identifier' &&
                node.expression.name === node.name &&
                options.svelteAllowShorthand &&
                !options.svelteStrictMode
                    ? ''
                    : concat(['=', ...printJsExpression()]),
            ]);
        case 'Class':
            return concat([
                'class:',
                node.name,
                node.expression.type === 'Identifier' &&
                node.expression.name === node.name &&
                options.svelteAllowShorthand &&
                !options.svelteStrictMode
                    ? ''
                    : concat(['=', ...printJsExpression()]),
            ]);
        case 'StyleDirective':
            const prefix = [
                'style:',
                node.name,
                node.modifiers && node.modifiers.length
                    ? concat(['|', join('|', node.modifiers)])
                    : '',
            ];

            if (isOrCanBeConvertedToShorthand(node) || node.value === true) {
                if (options.svelteStrictMode) {
                    return concat([...prefix, '="{', node.name, '}"']);
                } else if (options.svelteAllowShorthand) {
                    return concat([...prefix]);
                } else {
                    return concat([...prefix, '={', node.name, '}']);
                }
            } else {
                const quotes = !isLoneMustacheTag(node.value) || options.svelteStrictMode;
                const attrNodeValue = printAttributeNodeValue(path, print, quotes, node);
                if (quotes) {
                    return concat([...prefix, '=', '"', attrNodeValue, '"']);
                } else {
                    return concat([...prefix, '=', attrNodeValue]);
                }
            }
        case 'Let':
            return concat([
                'let:',
                node.name,
                // shorthand let directives have `null` expressions
                !node.expression ||
                (node.expression.type === 'Identifier' && node.expression.name === node.name)
                    ? ''
                    : concat(['=', ...printJsExpression()]),
            ]);
        case 'DebugTag':
            return concat([
                '{@debug',
                node.identifiers.length > 0
                    ? concat([' ', join(', ', path.map(print, 'identifiers'))])
                    : '',
                '}',
            ]);
        case 'Ref':
            return concat(['ref:', node.name]);
        case 'Comment': {
            const nodeAfterComment = getNextNode(path);

            if (isIgnoreStartDirective(node) && isNodeTopLevelHTML(node, path)) {
                ignoreRange = true;
            } else if (isIgnoreEndDirective(node) && isNodeTopLevelHTML(node, path)) {
                ignoreRange = false;
            } else if (
                // If there is no sibling node that starts right after us but the parent indicates
                // that there used to be, that means that node was actually an embedded `<style>`
                // or `<script>` node that was cut out.
                // If so, the comment does not refer to the next line we will see.
                // The `embed` function handles printing the comment in the right place.
                doesEmbedStartAfterNode(node, path) ||
                (isEmptyTextNode(nodeAfterComment) &&
                    doesEmbedStartAfterNode(nodeAfterComment, path))
            ) {
                return '';
            } else if (isIgnoreDirective(node)) {
                ignoreNext = true;
            }

            return printComment(node);
        }
        case 'Transition':
            const kind = node.intro && node.outro ? 'transition' : node.intro ? 'in' : 'out';
            return concat([
                kind,
                ':',
                node.name,
                node.modifiers && node.modifiers.length
                    ? concat(['|', join('|', node.modifiers)])
                    : '',
                node.expression ? concat(['=', ...printJsExpression()]) : '',
            ]);
        case 'Action':
            return concat([
                'use:',
                node.name,
                node.expression ? concat(['=', ...printJsExpression()]) : '',
            ]);
        case 'Animation':
            return concat([
                'animate:',
                node.name,
                node.expression ? concat(['=', ...printJsExpression()]) : '',
            ]);
        case 'RawMustacheTag':
            return concat([
                '{@html ',
                printJS(path, print, false, false, false, 'expression'),
                '}',
            ]);
        case 'Spread':
            return concat(['{...', printJS(path, print, false, false, false, 'expression'), '}']);
        case 'ConstTag':
            return concat([
                '{@const ',
                printJS(path, print, false, false, true, 'expression'),
                '}',
            ]);
    }

    try {
        return generate(node);
    } catch (err) {
        console.error(JSON.stringify(node, null, 4));
        throw new Error('unknown node type: ' + node.type);
    }
}

function assignCommentsToNodes(ast: ASTNode) {
    if (ast.module) {
        ast.module.comments = removeAndGetLeadingComments(ast, ast.module);
    }
    if (ast.instance) {
        ast.instance.comments = removeAndGetLeadingComments(ast, ast.instance);
    }
    if (ast.css) {
        ast.css.comments = removeAndGetLeadingComments(ast, ast.css);
    }
}

/**
 * Returns the comments that are above the current node and deletes them from the html ast.
 */
function removeAndGetLeadingComments(ast: ASTNode, current: Node): CommentInfo[] {
    const siblings = getChildren(ast.html);
    const comments: CommentNode[] = [];
    const newlines: TextNode[] = [];

    if (!siblings.length) {
        return [];
    }

    let node: Node = current;
    let prev: Node | undefined = siblings.find((child) => child.end === node.start);
    while (prev) {
        if (
            prev.type === 'Comment' &&
            !isIgnoreStartDirective(prev) &&
            !isIgnoreEndDirective(prev)
        ) {
            comments.push(prev);
            if (comments.length !== newlines.length) {
                newlines.push({ type: 'Text', data: '', raw: '', start: -1, end: -1 });
            }
        } else if (isEmptyTextNode(prev)) {
            newlines.push(prev);
        } else {
            break;
        }

        node = prev;
        prev = siblings.find((child) => child.end === node.start);
    }

    newlines.length = comments.length; // could be one more if first comment is preceeded by empty text node

    for (const comment of comments) {
        siblings.splice(siblings.indexOf(comment), 1);
    }

    for (const text of newlines) {
        siblings.splice(siblings.indexOf(text), 1);
    }

    return comments
        .map((comment, i) => ({
            comment,
            emptyLineAfter: getUnencodedText(newlines[i]).split('\n').length > 2,
        }))
        .reverse();
}

function printTopLevelParts(
    n: ASTNode,
    options: ParserOptions,
    path: FastPath<any>,
    print: PrintFn,
): Doc {
    if (options.svelteSortOrder === 'none') {
        const topLevelPartsByEnd: Record<number, any> = {};

        if (n.module) {
            n.module.type = 'Script';
            n.module.attributes = extractAttributes(getText(n.module, options));
            topLevelPartsByEnd[n.module.end] = n.module;
        }
        if (n.instance) {
            n.instance.type = 'Script';
            n.instance.attributes = extractAttributes(getText(n.instance, options));
            topLevelPartsByEnd[n.instance.end] = n.instance;
        }
        if (n.css) {
            n.css.type = 'Style';
            n.css.content.type = 'StyleProgram';
            topLevelPartsByEnd[n.css.end] = n.css;
        }

        const children = getChildren(n.html);
        for (let i = 0; i < children.length; i++) {
            const node = children[i];
            if (topLevelPartsByEnd[node.start]) {
                children.splice(i, 0, topLevelPartsByEnd[node.start]);
                delete topLevelPartsByEnd[node.start];
            }
        }

        const result = path.call(print, 'html');
        if (options.insertPragma && !hasPragma(options.originalText)) {
            return concat([`<!-- @format -->`, hardline, result]);
        } else {
            return result;
        }
    }

    const parts: Record<SortOrderPart, Doc[]> = {
        options: [],
        scripts: [],
        markup: [],
        styles: [],
    };

    // scripts
    if (n.module) {
        n.module.type = 'Script';
        n.module.attributes = extractAttributes(getText(n.module, options));
        parts.scripts.push(path.call(print, 'module'));
    }
    if (n.instance) {
        n.instance.type = 'Script';
        n.instance.attributes = extractAttributes(getText(n.instance, options));
        parts.scripts.push(path.call(print, 'instance'));
    }

    // styles
    if (n.css) {
        n.css.type = 'Style';
        n.css.content.type = 'StyleProgram';
        parts.styles.push(path.call(print, 'css'));
    }

    // markup
    const htmlDoc = path.call(print, 'html');
    if (htmlDoc) {
        parts.markup.push(htmlDoc);
    }
    if (svelteOptionsDoc) {
        parts.options.push(svelteOptionsDoc);
    }

    const docs = flatten(parseSortOrder(options.svelteSortOrder).map((p) => parts[p]));

    // Need to reset these because they are global and could affect the next formatting run
    ignoreNext = false;
    ignoreRange = false;
    svelteOptionsDoc = undefined;

    // If this is invoked as an embed of markdown, remove the last hardline.
    // The markdown parser tries this, too, but fails because it does not
    // recurse into concats. Doing this will prevent an empty line
    // at the end of the embedded code block.
    if (options.parentParser === 'markdown') {
        const lastDoc = docs[docs.length - 1];
        trimRight([lastDoc], isLine);
    }

    if (options.insertPragma && !hasPragma(options.originalText)) {
        return concat([`<!-- @format -->`, hardline, groupConcat(docs)]);
    } else {
        return groupConcat([join(hardline, docs)]);
    }
}

function printAttributeNodeValue(
    path: FastPath<any>,
    print: PrintFn,
    quotes: boolean,
    node: AttributeNode | StyleDirectiveNode,
) {
    const valueDocs = path.map((childPath) => childPath.call(print), 'value');

    if (!quotes || !formattableAttributes.includes(node.name)) {
        return concat(valueDocs);
    } else {
        return indent(groupConcat(trim(valueDocs, isLine)));
    }
}

function printSvelteBlockChildren(path: FastPath, print: PrintFn, options: ParserOptions): Doc {
    const node = path.getValue();
    const children = node.children;
    if (!children || children.length === 0) {
        return '';
    }

    const whitespaceAtStartOfBlock = checkWhitespaceAtStartOfSvelteBlock(node, options);
    const whitespaceAtEndOfBlock = checkWhitespaceAtEndOfSvelteBlock(node, options);
    const startline =
        whitespaceAtStartOfBlock === 'none'
            ? ''
            : whitespaceAtEndOfBlock === 'line' || whitespaceAtStartOfBlock === 'line'
            ? hardline
            : line;
    const endline =
        whitespaceAtEndOfBlock === 'none'
            ? ''
            : whitespaceAtEndOfBlock === 'line' || whitespaceAtStartOfBlock === 'line'
            ? hardline
            : line;

    const firstChild = children[0];
    const lastChild = children[children.length - 1];
    if (isTextNodeStartingWithWhitespace(firstChild)) {
        trimTextNodeLeft(firstChild);
    }
    if (isTextNodeEndingWithWhitespace(lastChild)) {
        trimTextNodeRight(lastChild);
    }

    return concat([
        indent(concat([startline, group(printChildren(path, print, options))])),
        endline,
    ]);
}

function printPre(
    node: Parameters<typeof printRaw>[0],
    originalText: string,
    path: FastPath,
    print: PrintFn,
): Doc {
    const result: Doc = [];
    const length = node.children.length;
    for (let i = 0; i < length; i++) {
        const child = node.children[i];
        if (child.type === 'Text') {
            const lines = originalText.substring(child.start, child.end).split(/\r?\n/);
            lines.forEach((line, j) => {
                if (j > 0) result.push(literalline);
                result.push(line);
            });
        } else {
            result.push(path.call(print, 'children', i));
        }
    }
    return concat(result);
}

function printChildren(path: FastPath, print: PrintFn, options: ParserOptions): Doc {
    if (isPreTagContent(path)) {
        return concat(path.map(print, 'children'));
    }

    const childNodes: Node[] = prepareChildren(path.getValue().children, path, print, options);
    // modify original array because it's accessed later through map(print, 'children', idx)
    path.getValue().children = childNodes;
    if (childNodes.length === 0) {
        return '';
    }

    const childDocs: Doc[] = [];
    let handleWhitespaceOfPrevTextNode = false;

    for (let i = 0; i < childNodes.length; i++) {
        const childNode = childNodes[i];
        if (childNode.type === 'Text') {
            handleTextChild(i, childNode);
        } else if (isBlockElement(childNode, options)) {
            handleBlockChild(i);
        } else if (isInlineElement(path, options, childNode)) {
            handleInlineChild(i);
        } else {
            childDocs.push(printChild(i));
            handleWhitespaceOfPrevTextNode = false;
        }
    }

    // If there's at least one block element and more than one node, break content
    const forceBreakContent =
        childNodes.length > 1 && childNodes.some((child) => isBlockElement(child, options));
    if (forceBreakContent) {
        childDocs.push(breakParent);
    }

    return concat(childDocs);

    function printChild(idx: number): Doc {
        return path.call(print, 'children', idx);
    }

    /**
     * Print inline child. Hug whitespace of previous text child if there was one.
     */
    function handleInlineChild(idx: number) {
        if (handleWhitespaceOfPrevTextNode) {
            childDocs.push(groupConcat([line, printChild(idx)]));
        } else {
            childDocs.push(printChild(idx));
        }
        handleWhitespaceOfPrevTextNode = false;
    }

    /**
     * Print block element. Add softlines around it if needed
     * so it breaks into a separate line if children are broken up.
     * Don't add lines at the start/end if it's the first/last child because this
     * kind of whitespace handling is done in the parent already.
     */
    function handleBlockChild(idx: number) {
        const prevChild = childNodes[idx - 1];
        if (
            prevChild &&
            !isBlockElement(prevChild, options) &&
            (prevChild.type !== 'Text' ||
                handleWhitespaceOfPrevTextNode ||
                !isTextNodeEndingWithWhitespace(prevChild))
        ) {
            childDocs.push(softline);
        }

        childDocs.push(printChild(idx));

        const nextChild = childNodes[idx + 1];
        if (
            nextChild &&
            (nextChild.type !== 'Text' ||
                // Only handle text which starts with a whitespace and has text afterwards,
                // or is empty but followed by an inline element. The latter is done
                // so that if the children break, the inline element afterwards is in a separate line.
                ((!isEmptyTextNode(nextChild) ||
                    (childNodes[idx + 2] && isInlineElement(path, options, childNodes[idx + 2]))) &&
                    !isTextNodeStartingWithLinebreak(nextChild)))
        ) {
            childDocs.push(softline);
        }
        handleWhitespaceOfPrevTextNode = false;
    }

    /**
     * Print text child. First/last child white space handling
     * is done in parent already. By definition of the Svelte AST,
     * a text node always is inbetween other tags. Add hardlines
     * if the users wants to have them inbetween.
     * If the text is trimmed right, toggle flag telling
     * subsequent (inline)block element to alter its printing logic
     * to check if they need to hug or print lines themselves.
     */
    function handleTextChild(idx: number, childNode: TextNode) {
        handleWhitespaceOfPrevTextNode = false;

        if (idx === 0 || idx === childNodes.length - 1) {
            childDocs.push(printChild(idx));
            return;
        }

        const prevNode = childNodes[idx - 1];
        const nextNode = childNodes[idx + 1];

        if (
            isTextNodeStartingWithWhitespace(childNode) &&
            // If node is empty, go straight through to checking the right end
            !isEmptyTextNode(childNode)
        ) {
            if (
                isInlineElement(path, options, prevNode) &&
                !isTextNodeStartingWithLinebreak(childNode)
            ) {
                trimTextNodeLeft(childNode);
                const lastChildDoc = childDocs.pop()!;
                childDocs.push(groupConcat([lastChildDoc, line]));
            }

            if (isBlockElement(prevNode, options) && !isTextNodeStartingWithLinebreak(childNode)) {
                trimTextNodeLeft(childNode);
            }
        }

        if (isTextNodeEndingWithWhitespace(childNode)) {
            if (
                isInlineElement(path, options, nextNode) &&
                !isTextNodeEndingWithLinebreak(childNode)
            ) {
                handleWhitespaceOfPrevTextNode = !prevNode || !isBlockElement(prevNode, options);
                trimTextNodeRight(childNode);
            }
            if (isBlockElement(nextNode, options) && !isTextNodeEndingWithLinebreak(childNode, 2)) {
                handleWhitespaceOfPrevTextNode = !prevNode || !isBlockElement(prevNode, options);
                trimTextNodeRight(childNode);
            }
        }

        childDocs.push(printChild(idx));
    }
}

/**
 * `svelte:options` is part of the html part but needs to be snipped out and handled
 * separately to reorder it as configured. The comment above it should be moved with it.
 * Do that here.
 */
function prepareChildren(
    children: Node[],
    path: FastPath,
    print: PrintFn,
    options: ParserOptions,
): Node[] {
    let svelteOptionsComment: Doc | undefined;
    const childrenWithoutOptions = [];
    const bracketSameLine = isBracketSameLine(options);

    for (let idx = 0; idx < children.length; idx++) {
        const currentChild = children[idx];

        if (currentChild.type === 'Text' && getUnencodedText(currentChild) === '') {
            continue;
        }

        if (isEmptyTextNode(currentChild) && doesEmbedStartAfterNode(currentChild, path)) {
            continue;
        }

        if (options.svelteSortOrder !== 'none') {
            if (isCommentFollowedByOptions(currentChild, idx)) {
                svelteOptionsComment = printComment(currentChild);
                const nextChild = children[idx + 1];
                idx += nextChild && isEmptyTextNode(nextChild) ? 1 : 0;
                continue;
            }

            if (currentChild.type === 'Options') {
                printSvelteOptions(currentChild, idx, path, print);
                continue;
            }
        }

        childrenWithoutOptions.push(currentChild);
    }

    const mergedChildrenWithoutOptions = [];

    for (let idx = 0; idx < childrenWithoutOptions.length; idx++) {
        const currentChild = childrenWithoutOptions[idx];
        const nextChild = childrenWithoutOptions[idx + 1];

        if (currentChild.type === 'Text' && nextChild && nextChild.type === 'Text') {
            // A tag was snipped out (f.e. svelte:options). Join text
            currentChild.raw += nextChild.raw;
            currentChild.data += nextChild.data;
            idx++;
        }

        mergedChildrenWithoutOptions.push(currentChild);
    }

    return mergedChildrenWithoutOptions;

    function printSvelteOptions(
        node: OptionsNode,
        idx: number,
        path: FastPath,
        print: PrintFn,
    ): void {
        svelteOptionsDoc = groupConcat([
            groupConcat([
                '<',
                node.name,
                indent(
                    groupConcat([
                        ...path.map(
                            printWithPrependedAttributeLine(node, options, print),
                            'children',
                            idx,
                            'attributes',
                        ),
                        bracketSameLine ? '' : dedent(line),
                    ]),
                ),
                ...[bracketSameLine ? ' ' : '', '/>'],
            ]),
            hardline,
        ]);
        if (svelteOptionsComment) {
            svelteOptionsDoc = groupConcat([svelteOptionsComment, hardline, svelteOptionsDoc]);
        }
    }

    function isCommentFollowedByOptions(node: Node, idx: number): node is CommentNode {
        if (node.type !== 'Comment' || isIgnoreEndDirective(node) || isIgnoreStartDirective(node)) {
            return false;
        }

        const nextChild = children[idx + 1];
        if (nextChild) {
            if (isEmptyTextNode(nextChild)) {
                const afterNext = children[idx + 2];
                return afterNext && afterNext.type === 'Options';
            }
            return nextChild.type === 'Options';
        }

        return false;
    }
}

/**
 * Split the text into words separated by whitespace. Replace the whitespaces by lines,
 * collapsing multiple whitespaces into a single line.
 *
 * If the text starts or ends with multiple newlines, two of those should be kept.
 */
function splitTextToDocs(node: TextNode): Doc[] {
    const text = getUnencodedText(node);
    let docs: Doc[] = text.split(/[\t\n\f\r ]+/);

    docs = join(line, docs).parts.filter((s) => s !== '');

    if (startsWithLinebreak(text)) {
        docs[0] = hardline;
    }
    if (startsWithLinebreak(text, 2)) {
        docs = [hardline, ...docs];
    }

    if (endsWithLinebreak(text)) {
        docs[docs.length - 1] = hardline;
    }
    if (endsWithLinebreak(text, 2)) {
        docs = [...docs, hardline];
    }

    return docs;
}

function printSvelteBlockJS(path: FastPath, print: PrintFn, name: string) {
    return printJS(path, print, false, true, false, name);
}

function printJS(
    path: FastPath,
    print: PrintFn,
    forceSingleQuote: boolean,
    forceSingleLine: boolean,
    removeParentheses: boolean,
    name: string,
) {
    path.getValue()[name].isJS = true;
    path.getValue()[name].forceSingleQuote = forceSingleQuote;
    path.getValue()[name].forceSingleLine = forceSingleLine;
    path.getValue()[name].removeParentheses = removeParentheses;
    return path.call(print, name);
}

function expandNode(node: any, parent?: any): string {
    if (node === null) {
        return '';
    }

    if (typeof node === 'string') {
        // pre-v3.20 AST
        return ' ' + node;
    }

    switch (node.type) {
        case 'ArrayExpression':
        case 'ArrayPattern':
            return ' [' + node.elements.map(expandNode).join(',').slice(1) + ']';
        case 'AssignmentPattern':
            return expandNode(node.left) + ' =' + expandNode(node.right);
        case 'Identifier':
            return ' ' + node.name;
        case 'Literal':
            return ' ' + node.raw;
        case 'ObjectExpression':
            return ' {' + node.properties.map((p: any) => expandNode(p, node)).join(',') + ' }';
        case 'ObjectPattern':
            return ' {' + node.properties.map(expandNode).join(',') + ' }';
        case 'Property':
            if (node.value.type === 'ObjectPattern' || node.value.type === 'ArrayPattern') {
                return ' ' + node.key.name + ':' + expandNode(node.value);
            } else if (
                (node.value.type === 'Identifier' && node.key.name !== node.value.name) ||
                (parent && parent.type === 'ObjectExpression')
            ) {
                return expandNode(node.key) + ':' + expandNode(node.value);
            } else {
                return expandNode(node.value);
            }
        case 'RestElement':
            return ' ...' + node.argument.name;
    }

    try {
        return generate(node);
    } catch (err) {
        console.error(JSON.stringify(node, null, 4));
        throw new Error('unknown node type: ' + node.type);
    }
}

function printComment(node: CommentNode) {
    let text = node.data;

    if (hasSnippedContent(text)) {
        text = unsnipContent(text);
    }

    return groupConcat(['<!--', text, '-->']);
}
