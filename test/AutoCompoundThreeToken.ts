import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./utils/network"

describe("AutoCompoundThreeToken", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string

    // Contracts
    let woof: Contract, meow: Contract, mwLP: Contract
    let tusd: Contract, muLP: Contract, wuLP: Contract
    let pancakeRouter: Contract
    let stakingRewards: Contract
    let converterImpl: Contract
    let converter: Contract
    let autoCompoundImpl: Contract
    let autoCompound: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const tbnbAddr = "0x509Ba9040dc4091da93f07cdD1e03Dea208e28bf"
    const woofAddr = "0x8dEdf46654B5A8d87a16D92C86ABB769578455B3"
    const meowAddr = "0x505A32c45676777e94689D16F30Df2a0Fa5dBa8e"
    const mwLPAddr = "0x304D9a9969Ea753b1A5d4eB9F3542cb870f4a843"
    const tusdAddr = "0xFD313Bc4bDc701726316DD39E91E7ef45A43F0F7"
    const pancakeRouterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"

    const ownerAddr = "0xb0123A6B61F0b5500EA92F33F24134c814364e3a"

    let ffSeconds
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
        // tusd = await ethers.getContractAt("mintersBEP2EToken", tusdAddr)
        // expect(await tusd.totalSupply()).gt(0)
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
        tusd = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("TUSD", "TUSD", deciaml, initSupply)
        expect(await woof.totalSupply()).equal(initSupply)
        mwLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, woof.address)
        muLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, tusd.address)
        wuLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(woof.address, tusd.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)
        await pancakeRouter.setLPAddr(meow.address, tusd.address, muLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, tusd.address)).to.equal(muLP.address)
        await pancakeRouter.setLPAddr(woof.address, tusd.address, wuLP.address)
        expect(await pancakeRouter.lpAddr(woof.address, tusd.address)).to.equal(wuLP.address)

        // Add MEOW/WOOF liquidity
        await meow.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await tusd.connect(operator).approve(pancakeRouter.address, MAX_INT)
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
        // Add MEOW/TUSD liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            tusd.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mwLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
        // Add WOOF/TUSD liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            woof.address,
            tusd.address,
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
            tusd.address,
            mwLP.address
        )
        expect(await stakingRewards.callStatic.owner()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsDistribution()).to.equal(ownerAddr)
        expect(await stakingRewards.callStatic.rewardsToken()).to.equal(tusd.address)
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

        const autoCompoundName = "MEOW/WOOF AutoCompound"
        autoCompoundImpl = await (
            await ethers.getContractFactory("AutoCompound", operator)
        ).deploy()
        const acInitData = autoCompoundImpl.interface.encodeFunctionData("initialize", [
            autoCompoundName,
            operatorAddress,
            operatorAddress,
            mwLP.address,
            converter.address,
            stakingRewards.address
        ])
        autoCompound = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            autoCompoundImpl.address,
            acInitData
        )
        // Change AutoCompound instance ABI from UpgradeProxy to AutoCompound implementation
        autoCompound = autoCompoundImpl.attach(autoCompound.address)
        expect(await autoCompound.callStatic.implementation()).to.equal(autoCompoundImpl.address)
        expect(await autoCompound.callStatic.name()).to.equal(autoCompoundName)
        expect(await autoCompound.callStatic.operator()).to.equal(operatorAddress)
        expect(await autoCompound.callStatic.converter()).to.equal(converter.address)
        expect(await autoCompound.callStatic.token0()).to.equal(meow.address)
        expect(await autoCompound.callStatic.token1()).to.equal(woof.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await tusd.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        // Transfer LP tokens to owner
        await mwLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        await muLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        await wuLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))

        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddr]
        })

        owner = ethers.provider.getSigner(ownerAddr)
        user = owner
        userAddr = ownerAddr

        // Owner add rewards to StakingRewards
        const newRewardAmount = ethers.utils.parseUnits('100000')
        await tusd.connect(operator).transfer(ownerAddr, newRewardAmount)
        await tusd.connect(owner).transfer(stakingRewards.address, newRewardAmount)
        const tx = await stakingRewards.connect(owner).notifyRewardAmount(newRewardAmount)
        expect(tx).to.emit(stakingRewards, "RewardAdded")
    })

    it("Should not re-initialize", async () => {
        const autoCompoundName = "BLABLABLA"
        await expect(autoCompound.connect(user).initialize(
            autoCompoundName,
            receiverAddress,
            receiverAddress,
            mwLP.address,
            converter.address,
            stakingRewards.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(autoCompound.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with MEOW", async () => {
        // const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        // expect(userMEOWBalanceBefore).to.be.gt(0)
        // const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        // expect(userWOOFBalanceBefore).to.be.gt(0)
        const userStakeBalanceBefore = await autoCompound.callStatic.balanceOf(userAddr)

        const autoCompoundLPBalanceBefore = await mwLP.callStatic.balanceOf(autoCompound.address)
        expect(autoCompoundLPBalanceBefore).to.equal(0)
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)

        const stakeAmount = BigNumber.from("100000000000000000000") // 100
        await meow.connect(user).approve(autoCompound.address, stakeAmount)

        const isMEOW = true
        const tx = await autoCompound.connect(user).stake(isMEOW, stakeAmount, minReceivedToken1Amount, minReceivedToken1Amount, minReceivedToken0Amount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedLPAmount = await autoCompound.callStatic.earned(userAddr)
        expect(earnedLPAmount).to.equal(0)
        // Should not accrue any LP tokens in AutoCompound contract
        const autoCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(autoCompound.address)
        expect(autoCompoundLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        const stakedAmount = autoCompoundStakeBalanceAfter.sub(autoCompoundStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with WOOF", async () => {
        // const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        // expect(userMEOWBalanceBefore).to.be.gt(0)
        // const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        // expect(userWOOFBalanceBefore).to.be.gt(0)

        // const autoCompoundLPBalanceBefore = await mwLP.callStatic.balanceOf(autoCompound.address)
        // expect(autoCompoundLPBalanceBefore).to.equal(0)
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        // const userStakeBalanceBefore = await autoCompound.callStatic.balanceOf(userAddr)

        const stakeAmount = BigNumber.from("100000000000000000000") // 100
        await woof.connect(user).approve(autoCompound.address, stakeAmount)

        const isMEOW = false
        const tx = await autoCompound.connect(user).stake(isMEOW, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        // const autoCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(autoCompound.address)
        // expect(autoCompoundLPBalanceAfter).to.equal(0)
        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        // const userStakeBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        const stakedAmount = autoCompoundStakeBalanceAfter.sub(autoCompoundStakeBalanceBefore)
        // expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        // expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)

        // LP token amount
        const stakeAmount = ethers.utils.parseUnits('1')
        await mwLP.connect(user).approve(autoCompound.address, stakeAmount)

        const tx = await autoCompound.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        const stakedAmount = autoCompoundStakeBalanceAfter.sub(autoCompoundStakeBalanceBefore)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should not earned before compound", async () => {
        const earnedLPAmountBefore = await autoCompound.callStatic.earned(userAddr)
        expect(earnedLPAmountBefore).to.equal(0)

        ffSeconds = 1000
        await fastforward(ffSeconds)

        const earnedLPAmountAfter = await autoCompound.callStatic.earned(userAddr)
        expect(earnedLPAmountAfter).to.equal(earnedLPAmountBefore)
    })

    it("Should compound", async () => {
        const userBalanceBefore = await autoCompound.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await autoCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await autoCompound.callStatic.earned(userAddr)

        const totalSupplyBefore = await autoCompound.callStatic.totalSupply()
        const lpAmountCompoundedBefore = await autoCompound.callStatic.lpAmountCompounded()
        const totalRewardShareBefore = await autoCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompound.callStatic.earned(autoCompound.address)
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        const autoCompoundEarnedRewardsBefore = await stakingRewards.callStatic.earned(autoCompound.address)
        // Should have accrued reward to compound
        expect(autoCompoundEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        expect(totalRewardShareBefore).to.equal(autoCompoundEarnedRewardsBefore)
        // Should not earn any LP tokens before compound
        expect(userEarnedLPAmountBefore).to.equal(0)
        expect(totalEarnedLPAmountBefore).to.equal(0)

        const tx = await autoCompound.connect(operator).compound(
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )

        // Should not change User's balance and total supply
        const userBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        expect(userBalanceAfter).to.equal(userBalanceBefore)
        const totalSupplyAfter = await autoCompound.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should match amount compounded and balance increase of AutoCompound 
        const lpAmountCompoundedAfter = await autoCompound.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        expect(autoCompoundStakeBalanceAfter.sub(autoCompoundStakeBalanceBefore)).to.equal(compoundedAmount)
        // Should be no rewards left
        const autoCompoundEarnedRewardsAfter = await stakingRewards.callStatic.earned(autoCompound.address)
        expect(autoCompoundEarnedRewardsAfter).to.equal(0)
        const userRewardShareAfter = await autoCompound.callStatic._share(userAddr)
        const userEarnedLPAmountAfter = await autoCompound.callStatic.earned(userAddr)
        const totalRewardShareAfter = await autoCompound.callStatic._shareTotal()
        const totalEarnedLPAmountAfter = await autoCompound.callStatic.earned(autoCompound.address)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareAfter).to.equal(userRewardShareAfter)
        // Assume no one else staking: user earned LP amount should be the same as total earned LP amount
        expect(totalEarnedLPAmountAfter).to.equal(userEarnedLPAmountAfter)
        // Should match total earned LP amount and compounded amount
        expect(totalEarnedLPAmountAfter).to.equal(compoundedAmount)
        
        const rewardsAmount = autoCompoundEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const compounded = ethers.utils.formatUnits(
            compoundedAmount,
            18
        )
        console.log(`Compounded ${compounded} lp with ${rewards} rewards`)
    })

    it("Should earned after compound", async () => {
        const earnedLPAmountBefore = await autoCompound.callStatic.earned(userAddr)

        const earnedRewards = ethers.utils.formatUnits(
            earnedLPAmountBefore,
            18
        )
        console.log(`Earned ${earnedRewards} rewards in ${ffSeconds} seconds`)
    })

    it("Should withdraw and convert to MEOW", async () => {
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await autoCompound.callStatic.balanceOf(userAddr)

        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)

        const withdrawAmount = ethers.utils.parseUnits("5")

        const token0Percentage = 100
        const tx = await autoCompound.connect(user).withdraw(minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, withdrawAmount)
        const receipt = await tx.wait()

        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userMEOWBalanceAfter).to.be.gt(userMEOWBalanceBefore)
        const userStakeBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const totalEarnedLPAmountAfter = await autoCompound.callStatic.earned(autoCompound.address)
        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        // Should match AutoCompound balance difference and user withdraw amount
        expect(autoCompoundStakeBalanceBefore.sub(autoCompoundStakeBalanceAfter)).to.equal(withdrawAmount)
        // Assume no one else staking: AutoCompound balance should be the same as user balance plus total compounded LP amount
        expect(autoCompoundStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))

        const withdrew = ethers.utils.formatUnits(
            withdrawAmount,
            18
        )

        console.log(`Withdrew ${withdrew} LP`)
        const receivedMEOW = ethers.utils.formatUnits(
            userMEOWBalanceAfter.sub(userMEOWBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedMEOW} MEOW`)
    })

    it("Should withdraw with LP Token", async () => {
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await autoCompound.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        const withdrawnAmount = autoCompoundStakeBalanceBefore.sub(autoCompoundStakeBalanceAfter)
        expect(withdrawnAmount).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
    })

    it("Should getReward and convert to MEOW", async () => {
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await autoCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await autoCompound.callStatic.earned(userAddr)
        const userStakeBalanceBefore = await autoCompound.callStatic.balanceOf(userAddr)

        const totalRewardShareBefore = await autoCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompound.callStatic.earned(autoCompound.address)
        const lpAmountCompoundedBefore = await autoCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)
        const autoCompoundStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(autoCompound.address)

        const token0Percentage = 100
        const tx = await autoCompound.connect(user)["getReward(uint256,uint256,uint256)"](minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage)
        const receipt = await tx.wait()

        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        // Should receive reward
        expect(userMEOWBalanceAfter).to.be.gt(userMEOWBalanceBefore)
        const userStakeBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await autoCompound.callStatic._share(userAddr)
        const totalRewardShareAfter = await autoCompound.callStatic._shareTotal()
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        // Assume no one else staking: should have no rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const totalEarnedLPAmountAfter = await autoCompound.callStatic.earned(autoCompound.address)
        const lpAmountCompoundedAfter = await autoCompound.callStatic.lpAmountCompounded()
        const receivedCompoundedLPAmount = lpAmountCompoundedBefore.sub(lpAmountCompoundedAfter)
        // Should receive compounded LP
        expect(receivedCompoundedLPAmount).to.equal(lpAmountCompoundedBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))

        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        // Should match the stake balance difference and received LP amount
        expect(autoCompoundStakeBalanceAfter).to.equal(autoCompoundStakeBalanceBefore.sub(receivedCompoundedLPAmount))
        // Assume no one else staking: AutoCompound balance should be the same as user balance plus total compounded LP amount
        expect(autoCompoundStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Get ${receivedCompoundedLP} reward LP`)
        const receivedMEOW = ethers.utils.formatUnits(
            userMEOWBalanceAfter.sub(userMEOWBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedMEOW} MEOW`)
    })

    it("Should compound", async () => {
        // Fast forward sometime, accrue some reward
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const lpAmountCompoundedBefore = await autoCompound.callStatic.lpAmountCompounded()
        const autoCompoundEarnedRewardsBefore = await stakingRewards.callStatic.earned(autoCompound.address)

        const tx = await autoCompound.connect(operator).compound(
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )

        // Should match amount compounded and balance increase of AutoCompound 
        const lpAmountCompoundedAfter = await autoCompound.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        
        const rewardsAmount = autoCompoundEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const compounded = ethers.utils.formatUnits(
            compoundedAmount,
            18
        )
        console.log(`Compounded ${compounded} lp with ${rewards} rewards`)
    })

    it("Should exit and convert to WOOF", async () => {

        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await autoCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await autoCompound.callStatic.earned(userAddr)

        const totalRewardShareBefore = await autoCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompound.callStatic.earned(autoCompound.address)
        const lpAmountCompoundedBefore = await autoCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)

        const token0Percentage = 0
        const tx = await autoCompound.connect(user)["exit(uint256,uint256,uint256)"](minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage)
        const receipt = await tx.wait()

        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userWOOFalanceAfter).to.be.gt(userWOOFBalanceBefore)
        const userStakeBalanceAfter = await autoCompound.callStatic.balanceOf(userAddr)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await autoCompound.callStatic._share(userAddr)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await autoCompound.callStatic._shareTotal()
        // Assume no one else staking: should be no total earned rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const lpAmountCompoundedAfter = await autoCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: should be no compounded LP left
        expect(lpAmountCompoundedAfter).to.equal(0)
        const receivedCompoundedLPAmount = lpAmountCompoundedBefore.sub(lpAmountCompoundedAfter)
        // Should receive compounded LP tokens
        expect(receivedCompoundedLPAmount).to.be.gt(0)
        const expectedEarnedWithdrawn = userRewardShareBefore
        const expectedCompoundedLPAmountReceived = lpAmountCompoundedBefore.mul(expectedEarnedWithdrawn).div(totalRewardShareBefore)
        // Should match actual received LP amount and expected received LP Amount
        // It should not be exact match but if the amount is small enough, it wouldn't matter
        const bonusAmountDiff = (
            receivedCompoundedLPAmount.gt(expectedCompoundedLPAmountReceived) ?
            receivedCompoundedLPAmount.sub(expectedCompoundedLPAmountReceived) : expectedCompoundedLPAmountReceived.sub(receivedCompoundedLPAmount)
        )
        expect(bonusAmountDiff).to.be.lt(10**6)
        const autoCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(autoCompound.address)
        // Should not accrue any LP tokens in AutoCompound contract
        expect(autoCompoundLPBalanceAfter).to.equal(0)
        const autoCompoundStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(autoCompound.address)
        // Assume no one else staking: should be no AutoCompound balance left
        expect(autoCompoundStakeBalanceAfter).to.equal(0)

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Exit and get ${receivedCompoundedLP} extra LP`)
        const receivedWOOF = ethers.utils.formatUnits(
            userWOOFalanceAfter.sub(userWOOFBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedWOOF} WOOF`)
    })
})