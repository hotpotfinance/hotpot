import { BigNumber } from "ethers"
import { ethers } from "hardhat"
import * as addr from "./address"

const normalStorageSlot = 0
const storageSlotMap = {
    [addr.WETH_ADDR]: [normalStorageSlot, 3],
    [addr.DAI_ADDR]: [normalStorageSlot, 2],
    [addr.USDC_ADDR]: [normalStorageSlot, 9],
    [addr.USDT_ADDR]: [normalStorageSlot, 2],
    [addr.BCNT_ADDR]: [normalStorageSlot, 0],
}

export function toBytes32(bn: BigNumber): string {
    return ethers.utils.hexlify(ethers.utils.zeroPad(bn.toHexString(), 32))
}

export async function setStorageAt(contractAddress: string, index: string, value: string) {
    await ethers.provider.send("hardhat_setStorageAt", [contractAddress, index, value])
    await ethers.provider.send("evm_mine", []) // Just mines to the next block
}

export async function setERC20Balance(
    contractAddress: string,
    userAddress: string,
    balance: BigNumber,
) {
    let storageSlotInfo = storageSlotMap[contractAddress]
    if (storageSlotInfo === undefined) {
        throw Error(`Storage slot of balanceOf not registered for contract: ${contractAddress}`)
    }
    let actualContractAddress = contractAddress
    let index: string
    if (storageSlotInfo[0] == normalStorageSlot) {
        const storageSlot = storageSlotInfo[1]
        index = ethers.utils.solidityKeccak256(
            ["uint256", "uint256"],
            [userAddress, storageSlot], // key, slot
        )
    } else {
        actualContractAddress = storageSlotInfo[1] as string
        const storageSlot = storageSlotInfo[2]
        index = ethers.utils.solidityKeccak256(
            ["uint256", "uint256"],
            [userAddress, storageSlot], // key, slot
        )
    }
    // remove padding for JSON RPC
    while (index.startsWith("0x0")) {
        index = "0x" + index.slice(3)
    }
    await setStorageAt(actualContractAddress, index, toBytes32(balance))
}