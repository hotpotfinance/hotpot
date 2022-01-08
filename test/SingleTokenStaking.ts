import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./network"

describe("SingleTokenStaking", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string

    // Contracts
    let woof: Contract, meow: Contract, mwLP: Contract
    let pancakeRouter: Contract
    let stakingRewards: Contract
    let converterImpl: Contract
    let converter: Contract
    let singleTokenStakingImpl: Contract
    let singleTokenStaking: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const tbnbAddr = "0x509Ba9040dc4091da93f07cdD1e03Dea208e28bf"
    const woofAddr = "0x8dEdf46654B5A8d87a16D92C86ABB769578455B3"
    const meowAddr = "0x505A32c45676777e94689D16F30Df2a0Fa5dBa8e"
    const mwLPAddr = "0x304D9a9969Ea753b1A5d4eB9F3542cb870f4a843"
    const pancakeRouterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"

    const ownerAddr = "0xb0123A6B61F0b5500EA92F33F24134c814364e3a"

    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0

    before(async () => {
        [receiver, operator] = await ethers.getSigners()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()

        // Use fork mainnet state
        // woof = await ethers.getContractAt("mintersBEP2EToken", woofAddr)
        // expect(await woof.totalSupply()).gt(0)
        // meow = await ethers.getContractAt("mintersBEP2EToken", meowAddr)
        // expect(await meow.totalSupply()).gt(0)
        // mwLP = await ethers.getContractAt("mintersBEP2EToken", mwLPAddr)
        // expect(await mwLP.totalSupply()).gt(0)
        // pancakeRouter = await ethers.getContractAt("IPancakeRouter", pancakeRouterAddr)

        // Deploy new contracts for testing
        const deciaml = 18
        const initSupply = ethers.utils.parseUnits("10000000")
        meow = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("MEOW", "MEOW", deciaml, initSupply)
        expect(await meow.totalSupply()).equal(initSupply)
        woof = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("WOOF", "WOOF", deciaml, initSupply)
        expect(await woof.totalSupply()).equal(initSupply)
        mwLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, woof.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)

        // Add liquidity
        await meow.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            woof.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mwLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))

        stakingRewards = await (
            await ethers.getContractFactory("StakingRewards", operator)
        ).deploy(
            operatorAddress,
            ownerAddr,
            woof.address,
            mwLP.address
        )
        expect(await stakingRewards.callStatic.owner()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsDistribution()).to.equal(ownerAddr)
        expect(await stakingRewards.callStatic.rewardsToken()).to.equal(woof.address)
        expect(await stakingRewards.callStatic.stakingToken()).to.equal(mwLP.address)

        const converterName = "Token Converter"
        converterImpl = await (
            await ethers.getContractFactory("Converter", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize", [
            tbnbAddr,
            converterName,
            ownerAddr,
            pancakeRouter.address
        ])
        converter = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            converterImpl.address,
            converterInitData
        )
        // Change instance ABI from UpgradeProxy to implementation
        converter = converterImpl.attach(converter.address)
        expect(await converter.callStatic.name()).to.equal(converterName)
        expect(await converter.callStatic.owner()).to.equal(ownerAddr)
        expect(await converter.callStatic.router()).to.equal(pancakeRouter.address)

        // singleTokenStaking = await ethers.getContractAt("SingleTokenStaking", singleTokenStakingAddr)
        const singleTokenStakingName = "MEOW/WOOF SingleTokenStaking"
        singleTokenStakingImpl = await (
            await ethers.getContractFactory("SingleTokenStaking", operator)
        ).deploy()
        const stsInitData = singleTokenStakingImpl.interface.encodeFunctionData("initialize", [
            singleTokenStakingName,
            operatorAddress,
            mwLP.address,
            converter.address,
            stakingRewards.address
        ])
        singleTokenStaking = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            singleTokenStakingImpl.address,
            stsInitData
        )
        // Change SingleTokenStaking instance ABI from UpgradeProxy to SingleTokenStaking implementation
        singleTokenStaking = singleTokenStakingImpl.attach(singleTokenStaking.address)
        expect(await singleTokenStaking.callStatic.implementation()).to.equal(singleTokenStakingImpl.address)
        expect(await singleTokenStaking.callStatic.name()).to.equal(singleTokenStakingName)
        expect(await singleTokenStaking.callStatic.converter()).to.equal(converter.address)
        expect(await singleTokenStaking.callStatic.token0()).to.equal(meow.address)
        expect(await singleTokenStaking.callStatic.token1()).to.equal(woof.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))

        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddr]
        })

        owner = ethers.provider.getSigner(ownerAddr)
        user = ethers.provider.getSigner(ownerAddr)
        userAddr = ownerAddr

        // User add liquidity
        await meow.connect(user).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(user).approve(pancakeRouter.address, MAX_INT)
        await pancakeRouter.connect(user).addLiquidity(
            meow.address,
            woof.address,
            ethers.utils.parseUnits("10000"),
            ethers.utils.parseUnits("10000"),
            0,
            0,
            userAddr,
            0
        )
        expect(await mwLP.callStatic.balanceOf(userAddr)).to.equal(ethers.utils.parseUnits("20000"))

        // Owner add rewards to StakingRewards
        const newRewardAmount = ethers.utils.parseUnits('100000')
        await woof.connect(operator).transfer(ownerAddr, newRewardAmount)
        await woof.connect(owner).transfer(stakingRewards.address, newRewardAmount)
        const tx = await stakingRewards.connect(owner).notifyRewardAmount(newRewardAmount)
        expect(tx).to.emit(stakingRewards, "RewardAdded")
    })

    it("Should not re-initialize", async () => {
        const singleTokenStakingName = "BLABLABLA"
        await expect(singleTokenStaking.connect(receiver).initialize(
            singleTokenStakingName,
            receiverAddress,
            mwLP.address,
            converter.address,
            stakingRewards.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(singleTokenStaking.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with MEOW", async () => {
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore).to.be.gt(0)

        const singleTokenStakingStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceBefore = await singleTokenStaking.callStatic.balanceOf(userAddr)

        const stakeAmount = BigNumber.from("100000000000000000000") // 100
        await meow.connect(user).approve(singleTokenStaking.address, stakeAmount)

        const isMEOW = true
        const tx = await singleTokenStaking.connect(user).stake(isMEOW, stakeAmount, minReceivedToken1Amount, minReceivedToken1Amount, minReceivedToken0Amount)
        const receipt = await tx.wait()

        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        // Should match user balance difference and stake amount, within 10% range
        // Due to dynamics of converting and adding liquidity, it would not be exact the same
        expect(userMEOWBalanceBefore.sub(userMEOWBalanceAfter)).to.be.gt(stakeAmount.mul(9).div(10))
        expect(userMEOWBalanceBefore.sub(userMEOWBalanceAfter)).to.be.lte(stakeAmount)

        // Should not earn anything the moment staking
        const earned = await singleTokenStaking.callStatic.earned(userAddr)
        expect(earned).to.equal(0)

        const singleTokenStakingLPBalanceAfter = await mwLP.callStatic.balanceOf(singleTokenStaking.address)
        // Should not accrue any LP tokens in AutoCompound contract
        expect(singleTokenStakingLPBalanceAfter).to.equal(0)
        const singleTokenStakingStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceAfter = await singleTokenStaking.callStatic.balanceOf(userAddr)
        const stakedAmount = singleTokenStakingStakeBalanceAfter.sub(singleTokenStakingStakeBalanceBefore)
        // Should match stake amount
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with WOOF", async () => {
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const singleTokenStakingStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceBefore = await singleTokenStaking.callStatic.balanceOf(userAddr)

        const stakeAmount = BigNumber.from("100000000000000000000") // 100
        await woof.connect(user).approve(singleTokenStaking.address, stakeAmount)

        const isMEOW = false
        const tx = await singleTokenStaking.connect(user).stake(isMEOW, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        // Should match user balance difference and stake amount, within 10% range
        // Due to dynamics of converting and adding liquidity, it would not be exact the same
        expect(userWOOFBalanceBefore.sub(userWOOFalanceAfter)).to.be.gt(stakeAmount.mul(9).div(10))
        expect(userWOOFBalanceBefore.sub(userWOOFalanceAfter)).to.be.lte(stakeAmount)

        const singleTokenStakingLPBalanceAfter = await mwLP.callStatic.balanceOf(singleTokenStaking.address)
        // Should not accrue any LP tokens in AutoCompound contract
        expect(singleTokenStakingLPBalanceAfter).to.equal(0)
        const singleTokenStakingStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceAfter = await singleTokenStaking.callStatic.balanceOf(userAddr)
        const stakedAmount = singleTokenStakingStakeBalanceAfter.sub(singleTokenStakingStakeBalanceBefore)
        // Should match stake amount
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should earned", async () => {
        const earnedBefore = await singleTokenStaking.callStatic.earned(userAddr)

        const ffSeconds = 1000
        await fastforward(ffSeconds)

        const earnedAfter = await singleTokenStaking.callStatic.earned(userAddr)
        expect(earnedAfter).to.be.gt(earnedBefore)

        const earned = ethers.utils.formatUnits(
            earnedAfter.sub(earnedBefore),
            18
        )
        console.log(`Earned ${earned} rewards in ${ffSeconds} seconds`)
    })

    it("Should withdraw and convert to MEOW", async () => {
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)

        const singleTokenStakingStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceBefore = await singleTokenStaking.callStatic.balanceOf(userAddr)
        const singleTokenStakingWOOFBalanceBefore = await woof.callStatic.balanceOf(singleTokenStaking.address)

        const withdrawAmount = BigNumber.from("5000000000000000000") // 5

        const token0Percentage = 100
        const tx = await singleTokenStaking.connect(user).withdraw(minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, withdrawAmount)
        const receipt = await tx.wait()

        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userMEOWBalanceAfter).to.be.gt(userMEOWBalanceBefore)

        const singleTokenStakingStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceAfter = await singleTokenStaking.callStatic.balanceOf(userAddr)
        const withdrawnAmount = singleTokenStakingStakeBalanceBefore.sub(singleTokenStakingStakeBalanceAfter)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawnAmount)
        expect(withdrawnAmount).to.be.gt(0)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
        const received = ethers.utils.formatUnits(
            userMEOWBalanceAfter.sub(userMEOWBalanceBefore),
            18
        )
        console.log(`Converted to ${received} MEOW`)
    })

    it("Should getReward and convert to MEOW", async () => {
        const userEarnedBefore = await singleTokenStaking.callStatic.earned(userAddr)
        const singleTokenStakingRewardBefore = await stakingRewards.callStatic.earned(singleTokenStaking.address)
        expect(singleTokenStakingRewardBefore).to.be.gt(0)
        expect(userEarnedBefore).to.be.lte(singleTokenStakingRewardBefore)

        const token0Percentage = 100
        const tx = await singleTokenStaking.connect(user).getReward(token0Percentage, minReceivedToken0Amount)

        const userEarnedAfter = await singleTokenStaking.callStatic.earned(userAddr)
        // Should empty user rewards
        expect(userEarnedAfter).to.equal(0)
        const singleTokenStakingRewardAfter = await stakingRewards.callStatic.earned(singleTokenStaking.address)
        // Assume no one else staking: should empty SingleTokenStaking rewards
        expect(singleTokenStakingRewardAfter).to.equal(0)

        const earned = ethers.utils.formatUnits(
            userEarnedBefore,
            18
        )
        console.log(`Got ${earned} rewards`)
    })

    it("Should exit and convert to WOOF", async () => {
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)

        const singleTokenStakingStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceBefore = await singleTokenStaking.callStatic.balanceOf(userAddr)

        const token0Percentage = 0
        const tx = await singleTokenStaking.connect(user).exit(minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage)
        const receipt = await tx.wait()

        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userWOOFalanceAfter).to.be.gt(userWOOFBalanceBefore)

        const singleTokenStakingStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(singleTokenStaking.address)
        const userStakeBalanceAfter = await singleTokenStaking.callStatic.balanceOf(userAddr)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)
        const withdrawnAmount = singleTokenStakingStakeBalanceBefore.sub(singleTokenStakingStakeBalanceAfter)
        // Should match user balance difference and SingleTokenStaking balance difference
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawnAmount)
        // Should withdraw
        expect(withdrawnAmount).to.be.gt(0)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Exit and withdrew ${withdrew} LP`)
        const received = ethers.utils.formatUnits(
            userWOOFalanceAfter.sub(userWOOFBalanceBefore),
            18
        )
        console.log(`Converted to ${received} WOOF`)
    })
})