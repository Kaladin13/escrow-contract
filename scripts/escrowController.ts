import { Address, beginCell, Cell, fromNano, OpenedContract, toNano } from '@ton/core';
import { Escrow, ESCROW_STATE } from '../wrappers/Escrow';
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

let escrowContract: OpenedContract<Escrow>;

const contractActions = ['Create new escrow deal', 'Choose existing escrow deal'];
const generalActions = ['Get status', 'Get info', 'Get royalty', 'Quit'];
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
    ui.write(`Deal asset is ${assetInfoStr}`);
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

    const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 10);

    if (transDone) {
        ui.write(`Approved deal successfully!`);
    } else {
        ui.write(`Couldn't approve the deal...`);
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

    const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 10);

    if (transDone) {
        ui.write(`Cancelled deal successfully!`);
    } else {
        ui.write(`Couldn't cancel the deal...`);
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
                    'Enter guarantor royalty amount (percent, up to 3 floating point digits)',
                    ui,
                );

                // true == ton
                const isAssetTON = await promptBool('What is the deal asset type?', ['TON', 'Jetton'], ui);
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
                escrowAddress = await promptAddress('Please enter minter address:', ui);
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
            case 'Cancel deal':
                await cancelDealAction(provider, ui);
                break;
            case 'Quit':
                done = true;
                break;
        }
    } while (!done);
}
