import { Address, beginCell, Cell, fromNano, OpenedContract, SendMode, toNano } from '@ton/core';
import { Escrow, ESCROW_OPCODES, ESCROW_STATE } from '../wrappers/Escrow';
import { compile, NetworkProvider, UIProvider } from '@ton/blueprint';
import {
    promptAddress,
    promptAmount,
    promptBool,
    promptNumber,
    stringAmountToNumber,
    waitForTransaction,
} from '../wrappers/ui-utils';
import { TonClient4 } from '@ton/ton';
import { Maybe } from '@ton/core/dist/utils/maybe';
import { JettonMinter } from '../wrappers/ft/JettonMinter';
import { JettonWallet } from '../wrappers/ft/JettonWallet';

let escrowContract: OpenedContract<Escrow>;

const contractActions = ['Create new escrow deal', 'Choose existing escrow deal'];
const generalActions = ['Get status', 'Get info', 'Get royalty', 'Change wallet code', 'Quit'];
const buyerActions = ['Fund'];
const guarantorActions = ['Approve deal', 'Cancel deal'];

const parseAssetAddress = (asset: Cell) => {
    try {
        const ds = asset.beginParse();
        const address = ds.loadAddress();

        return address;
    } catch (error) {
        return null;
    }
};

const getStatusDeal = async (provider: NetworkProvider, ui: UIProvider) => {
    const status = await escrowContract.getState();

    ui.write(`Current deal status is ${status === ESCROW_STATE.INIT ? 'INITIALIZED' : 'FUNDED'}`);
};

const getRoyalty = async (provider: NetworkProvider, ui: UIProvider) => {
    const roylaty = await escrowContract.getGuaratorRoyalty();

    ui.write(`Escrow deal guarantor royalty is ${fromNano(roylaty).toString()}`);
};

const getInfo = async (provider: NetworkProvider, ui: UIProvider) => {
    const info = await escrowContract.getEscrowData();
    const asset = parseAssetAddress(info.assetAddress);
    const assetInfoStr = asset === null ? 'TON' : `Jetton with address ${asset.toString({ urlSafe: true })}`;

    ui.write(`Ctx id is ${info.ctxId}`);
    ui.write(`Seller address is ${info.sellerAddress.toString({ urlSafe: true })}`);
    ui.write(`Guarantor address is ${info.guarantorAddress.toString({ urlSafe: true })}`);
    ui.write(`Buyer address is ${info.buyer_address?.toString({ urlSafe: true })}`);
    ui.write(`Deal amount is ${fromNano(info.dealAmount).toString()}`);
    ui.write(`Current deal status is ${info.state === ESCROW_STATE.INIT ? 'INITIALIZED' : 'FUNDED'}`);
    ui.write(`Guarantor royalty percent is ${info.guarantor_royalty_percent / 1000}%`);
    ui.write(`Deal asset is ${assetInfoStr}`);
};

// jetton EQBf3WrpAIEhW6RdyHYrOmzJq1i6uQdIDtwJk7IyxEmi7Hoy
// ton    EQANoQXO0o6lGjuwj6beIZ4R06vy0zcGBltznFfJKXTKXenH
const fundingAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const info = await escrowContract.getEscrowData();
    const asset = parseAssetAddress(info.assetAddress);
    const assetInfoStr = asset === null ? 'TON' : `Jetton with address ${asset.toString({ urlSafe: true })}`;
    ui.write(`Deal asset is ${assetInfoStr}`);
    ui.write(`Deal amount is ${fromNano(info.dealAmount)}`);

    const isFundungSure = await promptBool('Are you sure you want to fund deal?', ['Yes', 'No'], ui);

    if (!isFundungSure) {
        return;
    }

    const api = provider.api() as TonClient4;

    const seqno = (await api.getLastBlock()).last.seqno;
    const lastTransaction = (await api.getAccount(seqno, escrowContract.address)).account.last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    if (asset === null) {
        await provider.sender().send({
            to: escrowContract.address,
            value: BigInt(info.dealAmount),
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    } else {
        try {
            const buyerAddress = await promptAddress(
                `Please enter buyer address (should be current sender as well)`,
                ui,
            );

            const minter = provider.open(JettonMinter.createFromAddress(asset));
            const buyerJettonWallet = provider.open(
                JettonWallet.createFromAddress(await minter.getWalletAddress(buyerAddress)),
            );

            ui.write(`Buyer jetton wallet is ${buyerJettonWallet.address.toString({ urlSafe: true })}`);

            const seqno = (await api.getLastBlock()).last.seqno;
            const contractState = (await api.getAccount(seqno, buyerJettonWallet.address)).account.state;

            if (contractState.type !== 'active' || contractState.code == null) {
                ui.write('This jetton wallet contract is not active!');
                return;
            } else {
                const stateCode = Cell.fromBase64(contractState.code!);
                const jwalletCode = await compile('ft/JettonWallet');
                if (!stateCode.equals(jwalletCode)) {
                    ui.write('Jetton wallet contract code differs from the current contract version!\n');
                    ui.write(
                        `Use the same jetton as https://github.com/ton-blockchain/token-contract/blob/main/ft/jetton-wallet.fc or change escrow init state`,
                    );

                    return;
                }
            }

            await buyerJettonWallet.sendTransfer(
                provider.sender(),
                toNano('0.1'),
                BigInt(info.dealAmount),
                escrowContract.address,
                buyerAddress,
                null as unknown as Cell,
                toNano('0.05'),
                null as unknown as Cell,
            );
        } catch (e) {
            ui.write(`Couldn't fund jetton...`);
            return;
        }
    }

    const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 15);

    if (transDone) {
        const status = await escrowContract.getState();

        if (status === ESCROW_STATE.FUNDED) {
            ui.write(`Funded successfully!`);
        } else {
            ui.write(`Couldn't fund the deal...`);
        }
    } else {
        ui.write(`Couldn't fund the deal...`);
    }
};

const approveDealAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const isApproveSure = await promptBool('Are you sure you want to approve deal?', ['Yes', 'No'], ui);

    if (!isApproveSure) {
        return;
    }

    const api = provider.api() as TonClient4;

    const seqno = (await api.getLastBlock()).last.seqno;
    const lastTransaction = (await api.getAccount(seqno, escrowContract.address)).account.last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    await escrowContract.sendApprove(provider.sender(), toNano('0.05'));

    // since we are destroying contract on success, any catch is positive cause contract stoped existing
    try {
        const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 10);

        if (transDone) {
            const seqno = (await api.getLastBlock()).last.seqno;
            const balance = (await api.getAccount(seqno, escrowContract.address)).account.balance;
            if (parseFloat(balance.coins) == 0) {
                ui.write(`Approved deal successfully!`);
            } else {
                ui.write(`Couldn't approve the deal...`);
            }
        } else {
            ui.write(`Couldn't approve the deal...`);
        }
    } catch (e) {
        ui.write(`Approved deal successfully!`);
    }
};

const cancelDealAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const isCancelSure = await promptBool('Are you sure you want to cancel deal?', ['Yes', 'No'], ui);

    if (!isCancelSure) {
        return;
    }

    const api = provider.api() as TonClient4;

    const seqno = (await api.getLastBlock()).last.seqno;
    const lastTransaction = (await api.getAccount(seqno, escrowContract.address)).account.last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    await escrowContract.sendCancel(provider.sender(), toNano('0.05'));

    try {
        const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 10);

        if (transDone) {
            const seqno = (await api.getLastBlock()).last.seqno;
            const balance = (await api.getAccount(seqno, escrowContract.address)).account.balance;
            if (parseFloat(balance.coins) == 0) {
                ui.write(`Cancelled deal successfully!`);
            } else {
                ui.write(`Couldn't cancel the deal...`);
            }
        } else {
            ui.write(`Couldn't cancel the deal...`);
        }
    } catch (e) {
        ui.write(`Cancelled deal successfully!`);
    }
};

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const hasSender = sender.address !== undefined;
    const api = provider.api() as TonClient4;
    const escrowCode = await compile('Escrow');
    let done = false;
    let retry: boolean;
    let escrowAddress: Address;

    do {
        retry = false;
        const action = await ui.choose('Pick action:', contractActions, (c) => c);

        switch (action) {
            case 'Create new escrow deal':
                const ctxId = await promptNumber('Enter ctx id', ui);
                const dealAmount = await promptAmount('Enter deal amount (e.g. 1.25, without nano)', ui);
                const sellerAddress = await promptAddress('Enter seller address:', ui);
                const guarantorAddress = await promptAddress('Enter guarantor address:', ui);
                // need to multiply by 1000
                const royaltyAmount = await promptAmount(
                    'Enter guarantor royalty amount (percent, up to 3 floating point digits, e.g. 20.25)',
                    ui,
                );

                // true == ton
                const isAssetTON = await promptBool('What is the deal asset type?', ['TON', 'Jetton'], ui, true);
                let assetCell: Maybe<Cell> = null;
                let jcodeCell: Maybe<Cell> = null;

                if (!isAssetTON) {
                    ui.write(
                        `Current deployment would be using https://github.com/ton-blockchain/token-contract/blob/main/ft/jetton-wallet.fc as jetton wallet code`,
                    );
                    const minterAddress = await promptAddress('Enter asset jetton address (minter address):', ui);
                    assetCell = beginCell().storeAddress(minterAddress).endCell();

                    jcodeCell = await compile('ft/JettonWallet');
                }

                const royalty = Number(Number(royaltyAmount).toFixed(3)) * 1000;
                console.log(
                    ctxId,
                    stringAmountToNumber(dealAmount),
                    guarantorAddress,
                    royalty,
                    sellerAddress,
                    assetCell,
                    jcodeCell,
                );

                const escrow = provider.open(
                    Escrow.createFromConfig(
                        {
                            ctxId,
                            dealAmount: stringAmountToNumber(dealAmount),
                            guarantorAddress,
                            guarantorRoyaltyPercent: royalty,
                            sellerAddress,
                            assetAddress: assetCell,
                            jettonWalletCode: jcodeCell,
                        },
                        escrowCode,
                    ),
                );

                await escrow.sendDeploy(sender, toNano('0.05'));
                await provider.waitForDeploy(escrow.address);

                ui.write(`Escrow contract deployed at ${escrow.address.toString({ urlSafe: true })}`);
                escrowAddress = escrow.address;

                break;
            case 'Choose existing escrow deal':
                escrowAddress = await promptAddress('Please enter escrow address:', ui);
                const seqno = (await api.getLastBlock()).last.seqno;
                const contractState = (await api.getAccount(seqno, escrowAddress)).account.state;

                if (contractState.type !== 'active' || contractState.code == null) {
                    retry = true;
                    ui.write('This escrow contract is not active!\nPlease use another address, or deploy it first');
                } else {
                    const stateCode = Cell.fromBase64(contractState.code!);
                    if (!stateCode.equals(escrowCode)) {
                        ui.write('Contract code differs from the current contract version!\n');
                        const resp = await ui.choose('Use address anyway', ['Yes', 'No'], (c) => c);
                        retry = resp == 'No';
                    }
                }
                break;
        }
    } while (retry);

    // escrow address is filled
    escrowContract = provider.open(Escrow.createFromAddress(escrowAddress!));
    const escrowData = await escrowContract.getEscrowData();

    const isGuarantor = hasSender ? escrowData.guarantorAddress.equals(sender.address) : true;
    const isFunded = escrowData.state === ESCROW_STATE.FUNDED;

    let actions = [...generalActions];

    if (isGuarantor) {
        ui.write(`Current sender (if present) is escrow guarantor!`);
        actions = [...actions, ...guarantorActions];
    }
    if (!isFunded) {
        ui.write(`Current escrow deal wasn't funded yet!`);
        actions = [...actions, ...buyerActions];
    }

    do {
        const action = await ui.choose('Pick action:', actions, (c) => c);

        switch (action) {
            case 'Get status':
                await getStatusDeal(provider, ui);
                break;
            case 'Get info':
                await getInfo(provider, ui);
                break;
            case 'Get royalty':
                await getRoyalty(provider, ui);
                break;
            case 'Approve deal':
                await approveDealAction(provider, ui);
                break;
            case 'Fund':
                await fundingAction(provider, ui);
                break;
            case 'Cancel deal':
                await cancelDealAction(provider, ui);
                break;
            case 'Quit':
                done = true;
                break;
        }
    } while (!done);
}
