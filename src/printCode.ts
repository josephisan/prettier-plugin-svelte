import type { Ast } from 'svelte/types/compiler/interfaces';
import prettier from 'prettier/standalone';
import * as p from './index';

export function printCode(ast: Ast) {
    const override = {
        ...p,
        parsers: {
            ...p.parsers,
            svelte: {
                ...p.parsers.svelte,
                parse: () => {
                    return { ...ast, __isRoot: true };
                },
            },
        },
    };
    return prettier.format(' dummy ', {
        parser: 'svelte',
        plugins: [override as any],
    });
}