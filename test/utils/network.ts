import { ethers } from "hardhat"

export async function mineBlocks(numBlocks) {
    for (let i = 0; i < numBlocks; i++) {
        await ethers.provider.send("evm_mine", [])
    }
}

export async function mineBlockWithTimestamp(timestamp) {
    await ethers.provider.send("evm_mine", [timestamp])
}

export async function fastforward(duration: number) {
    await ethers.provider.send("evm_increaseTime", [duration])
    await ethers.provider.send("evm_mine", [])
}

// advanceNextBlockTimestamp is mainly used before mutation function
export async function advanceNextBlockTimestamp(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds])
}

export async function getCurrentBlockTimestamp(): Promise<number> {
    const provider = ethers.provider
    const blockNumber = await provider.getBlockNumber()
    const block = await provider.getBlock(blockNumber)
    return block.timestamp
}

// setNextBlockTimestamp is mainly used before mutation function
export async function setNextBlockTimestamp(timestamp: number) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp])
}
