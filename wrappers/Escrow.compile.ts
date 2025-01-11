import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['contracts/escrow.fc', 'contracts/ft/params.fc'],
};
