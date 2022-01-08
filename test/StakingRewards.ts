import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./utils/network"

describe.skip("StakingRewards", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let user: Signer, userAddress: string

    // Contracts
    let woof: Contract, meow: Contract, mwLP: Contract
    let stakingRewards: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const rewardAmount = BigNumber.from("100000000000000000000000") // 100k
    const stakeAmount = BigNumber.from("1000") // 1k

    before(async () => {
        [user, operator] = await ethers.getSigners()
        userAddress = await user.getAddress()
        operatorAddress = await operator.getAddress()

        woof = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy(
            "WOOF WOOF WOOF",
            "WOOF",
            18,
            BigNumber.from("100000000000000000000000000") // 10 mil
        )
        meow = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy(
            "MEOW MEOW MEOW",
            "MEOW",
            18,
            BigNumber.from("100000000000000000000000000") // 10 mil
        )
        mwLP = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy(
            "Pancake LPs",
            "Cake-LP",
            18,
            BigNumber.from("10000000000000000000000") // 10k
        )

        stakingRewards = await (
            await ethers.getContractFactory("StakingRewards", operator)
        ).deploy(
            operatorAddress,
            operatorAddress,
            woof.address,
            mwLP.address
        )
        expect(await stakingRewards.callStatic.owner()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsDistribution()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsToken()).to.equal(woof.address)
        expect(await stakingRewards.callStatic.stakingToken()).to.equal(mwLP.address)

        // Transfer ether to user
        // await operator.sendTransaction({to: user.address, value: ethers.utils.parseUnits('1000')})

        // User approvals
        await mwLP.connect(operator).transfer(userAddress, stakeAmount)
        await mwLP.connect(user).approve(stakingRewards.address, MAX_INT)
    })

    it("Should notify reward", async () => {
        await woof.connect(operator).transfer(stakingRewards.address, rewardAmount)
        const stakingRewardsWOOFBalanceBefore = await woof.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsWOOFBalanceBefore).to.equal(rewardAmount)
        const rewardRateBefore = await stakingRewards.callStatic.rewardRate()
        expect(rewardRateBefore).to.equal(0)
        await stakingRewards.connect(operator).notifyRewardAmount(rewardAmount)
        const periodFinishAfter = await stakingRewards.callStatic.periodFinish()
        expect(periodFinishAfter).to.be.gt(0)
        const rewardRateAfter = await stakingRewards.callStatic.rewardRate()
        expect(rewardRateAfter).to.be.gt(0)
    })

    it("Should stake", async () => {
        const userBalanceBefore = await stakingRewards.callStatic.balanceOf(userAddress)
        expect(userBalanceBefore).to.equal(0)
        const stTotalSupplyBefore = await stakingRewards.callStatic.totalSupply()
        expect(stTotalSupplyBefore).to.equal(0)
        const stakingRewardsLPBalanceBefore = await mwLP.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsLPBalanceBefore).to.equal(0)

        const tx = await stakingRewards.connect(user).stake(stakeAmount)
        const receipt = await tx.wait()

        const userBalanceAfter = await stakingRewards.callStatic.balanceOf(userAddress)
        const userEarnedAfter = await stakingRewards.callStatic.earned(userAddress)
        // const userWOOFBalanceAfter = await await woof.callStatic.balanceOf(userAddress)
        expect(userBalanceAfter).to.equal(stakeAmount)
        expect(userEarnedAfter).to.equal(0)
        // expect(userWOOFBalanceAfter).to.equal(userWOOFBalanceBefore.add(woofEarnedBefore))

        const stTotalSupplyAfter = await stakingRewards.callStatic.totalSupply()
        expect(stTotalSupplyAfter).to.equal(stakeAmount)
        const stakingRewardsLPBalanceAfter = await mwLP.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsLPBalanceAfter).to.equal(stakeAmount)
    })

    it("Should earn", async () => {
        const timeFastForward = 3600*24
        await fastforward(timeFastForward)

        expect(await stakingRewards.callStatic.earned(userAddress)).to.be.gt(0)
    })

    it("Should exit", async () => {
        const userBalanceBefore = await stakingRewards.callStatic.balanceOf(userAddress)
        expect(userBalanceBefore).to.equal(stakeAmount)
        const userEarnedBefore = await stakingRewards.callStatic.earned(userAddress)
        expect(userEarnedBefore).to.be.gt(0)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddress)
        expect(userWOOFBalanceBefore).to.equal(0)
        const userLPBalanceBefore = await await mwLP.callStatic.balanceOf(userAddress)
        expect(userLPBalanceBefore).to.equal(0)
        const stTotalSupplyBefore = await stakingRewards.callStatic.totalSupply()
        expect(stTotalSupplyBefore).to.equal(stakeAmount)
        const stakingRewardsLPBalanceBefore = await mwLP.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsLPBalanceBefore).to.equal(stakeAmount)
        const stakingRewardsWOOFBalanceBefore = await woof.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsWOOFBalanceBefore).to.equal(rewardAmount)

        const tx = await stakingRewards.connect(user).exit()
        const receipt = await tx.wait()

        const userBalanceAfter = await stakingRewards.callStatic.balanceOf(userAddress)
        const woofEarnedAfter = await stakingRewards.callStatic.earned(userAddress)
        const userWOOFBalanceAfter = await await woof.callStatic.balanceOf(userAddress)
        const userLPBalanceAfter = await await mwLP.callStatic.balanceOf(userAddress)
        expect(userBalanceAfter).to.equal(0)
        expect(woofEarnedAfter).to.equal(0)
        expect(userWOOFBalanceAfter).to.gt(userEarnedBefore)
        expect(userLPBalanceAfter).to.equal(stakeAmount)

        const stTotalSupplyAfter = await stakingRewards.callStatic.totalSupply()
        expect(stTotalSupplyAfter).to.equal(0)
        const stakingRewardsLPBalanceAfter = await mwLP.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsLPBalanceAfter).to.equal(0)
        const stakingRewardsWOOFBalanceAfter = await woof.callStatic.balanceOf(stakingRewards.address)
        expect(stakingRewardsWOOFBalanceAfter).to.be.lt(rewardAmount.sub(userEarnedBefore))
    })
})