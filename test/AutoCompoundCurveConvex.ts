import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./utils/network"
import * as addr from "./utils/address"
import { setERC20Balance } from "./utils/balance"
import { parseLogsByName } from "./utils/events"
import { encodePath, FeeAmount } from "./utils/uniV3"

describe("AutoCompoundCurveConvex", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddress: string

    // Contracts
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20"
    let dai: Contract, usdc: Contract, cDAIcUSDCLP: Contract
    let cvx: Contract, crv: Contract
    let bcnt: Contract
    let curveDepositCompound: Contract
    let convexBooster: Contract
    let convexBaseRewardPool: Contract
    let uniswapV2Router: Contract
    let converterImpl: Contract
    let converter: Contract
    let autoCompoundCCImpl: Contract
    let autoCompoundCC: Contract

    const cDAIcUSDCLPAddr = "0x845838DF265Dcd2c412A1Dc9e959c7d08537f8a2"
    const curveDepositCompoundAddr = "0xeB21209ae4C2c9FF2a86ACA31E123764A3B6Bc06" // cDAI + cUSDC Deposit Compound
    const pid = 0 // cDAI + cUSDC BaseRewardPool ID
    const convexBoosterAddr = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31"
    const convexBaseRewardPoolAddr = "0xf34DFF761145FF0B05e917811d488B441F33a968" // cDAI + cUSDC BaseRewardPool
    const uniV2RouterAddr = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    const uniV3RouterAddr = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

    let cvxUniV3SwapPath = encodePath(
        [addr.CVX_ADDR, addr.WETH_ADDR, addr.DAI_ADDR],
        [FeeAmount.HIGH, FeeAmount.LOW]
    )
    let bcntUniV3SwapPath = encodePath(
        [addr.DAI_ADDR, addr.WETH_ADDR, addr.BCNT_ADDR],
        [FeeAmount.LOW, FeeAmount.HIGH]
    )

    let ffSeconds
    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedBCNTAmount = 0, minReceivedLPAmount = 0

    before(async () => {
        [user, receiver, operator] = await ethers.getSigners()
        userAddress = await user.getAddress()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()

        // await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})

        // Use fork mainnet state
        dai = await ethers.getContractAt(IERC20, addr.DAI_ADDR)
        expect(await dai.totalSupply()).gt(0)
        usdc = await ethers.getContractAt(IERC20, addr.USDC_ADDR)
        expect(await usdc.totalSupply()).gt(0)
        cDAIcUSDCLP = await ethers.getContractAt(IERC20, cDAIcUSDCLPAddr)
        expect(await cDAIcUSDCLP.totalSupply()).gt(0)
        cvx = await ethers.getContractAt(IERC20, addr.CVX_ADDR)
        expect(await cvx.totalSupply()).gt(0)
        crv = await ethers.getContractAt(IERC20, addr.CRV_ADDR)
        expect(await crv.totalSupply()).gt(0)
        bcnt = await ethers.getContractAt(IERC20, addr.BCNT_ADDR)
        expect(await bcnt.totalSupply()).gt(0)
        curveDepositCompound = await ethers.getContractAt("IDepositCompound", curveDepositCompoundAddr)
        convexBooster = await ethers.getContractAt("IConvexBooster", convexBoosterAddr)
        const poolInfo = await convexBooster.callStatic.poolInfo(pid)
        expect(cDAIcUSDCLP.address).to.equal(poolInfo.lptoken)
        convexBaseRewardPool = await ethers.getContractAt("IConvexBaseRewardPool", convexBaseRewardPoolAddr)
        expect(convexBaseRewardPool.address).to.equal(poolInfo.crvRewards)
        expect(await convexBaseRewardPool.callStatic.rewardToken()).to.equal(crv.address)
        expect(await convexBaseRewardPool.callStatic.stakingToken()).to.equal(poolInfo.token)

        // Set token balance
        await setERC20Balance(dai.address, userAddress, ethers.utils.parseEther("10000000"))
        await setERC20Balance(usdc.address, userAddress, ethers.utils.parseUnits("10000000", "mwei"))

        // Deploy Converter
        const converterName = "Token Converter with UniV3"
        converterImpl = await (
            await ethers.getContractFactory("ConverterUniV3", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize(address,string,address,address,address)", [
            addr.WETH_ADDR,  // Route the swap path through native token
            converterName,
            operatorAddress,
            uniV2RouterAddr,
            uniV3RouterAddr
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
        expect(await converter.callStatic.owner()).to.equal(operatorAddress)
        expect(await converter.callStatic.router()).to.equal(uniV2RouterAddr)
        expect(await converter.callStatic.routerUniV3()).to.equal(uniV3RouterAddr)

        const autoCompoundCCName = "DAI/USDC AutoCompoundCurveConvex"
        autoCompoundCCImpl = await (
            await ethers.getContractFactory("AutoCompoundCurveConvex", operator)
        ).deploy()
        const acInitData = autoCompoundCCImpl.interface.encodeFunctionData("initialize", [
            autoCompoundCCName,
            pid,
            operatorAddress,
            operatorAddress,
            converter.address,
            curveDepositCompound.address,
            convexBooster.address,
            convexBaseRewardPool.address,
            addr.BCNT_ADDR
        ])
        autoCompoundCC = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            autoCompoundCCImpl.address,
            acInitData
        )
        // Change AutoCompoundCurveConvex instance ABI from UpgradeProxy to AutoCompoundCurveConvex implementation
        autoCompoundCC = autoCompoundCCImpl.attach(autoCompoundCC.address)
        expect(await autoCompoundCC.callStatic.implementation()).to.equal(autoCompoundCCImpl.address)
        expect(await autoCompoundCC.callStatic.name()).to.equal(autoCompoundCCName)
        expect(await autoCompoundCC.callStatic.operator()).to.equal(operatorAddress)
        expect(await autoCompoundCC.callStatic.converter()).to.equal(converter.address)
        expect(await autoCompoundCC.callStatic.token0()).to.equal(dai.address)
        expect(await autoCompoundCC.callStatic.token1()).to.equal(usdc.address)
        expect(await autoCompoundCC.callStatic.crv()).to.equal(crv.address)
        expect(await autoCompoundCC.callStatic.cvx()).to.equal(cvx.address)
        // Set UniV3 path
        expect(cvxUniV3SwapPath).to.equal(
            encodePath(
                [addr.CVX_ADDR, addr.WETH_ADDR, await autoCompoundCC.callStatic.token0()],
                [FeeAmount.HIGH, FeeAmount.LOW]
            )
        )
        await autoCompoundCC.updateCVXUniV3SwapPath(cvxUniV3SwapPath)
        expect(await autoCompoundCC.callStatic.cvxUniV3SwapPath()).to.equal(cvxUniV3SwapPath)
        expect(bcntUniV3SwapPath).to.equal(
            encodePath(
                [await autoCompoundCC.callStatic.token0(), addr.WETH_ADDR, addr.BCNT_ADDR, ],
                [FeeAmount.LOW, FeeAmount.HIGH]
            )
        )
        await autoCompoundCC.updateBCNTUniV3SwapPath(bcntUniV3SwapPath)
        expect(await autoCompoundCC.callStatic.bcntUniV3SwapPath()).to.equal(bcntUniV3SwapPath)
    })

    it("Should not re-initialize", async () => {
        const autoCompoundCCName = "BLABLABLA"
        await expect(autoCompoundCC.connect(user).initialize(
            autoCompoundCCName,
            pid,
            receiverAddress,
            receiverAddress,
            converter.address,
            curveDepositCompound.address,
            convexBooster.address,
            convexBaseRewardPool.address,
            addr.BCNT_ADDR
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(autoCompoundCC.connect(receiver).upgradeTo(
            receiverAddress
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with DAI", async () => {
        // const userDAIBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        // expect(userDAIBalanceBefore).to.be.gt(0)
        // const userUSDCBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        // expect(userUSDCBalanceBefore).to.be.gt(0)

        const autoCompoundCCLPBalanceBefore = await cDAIcUSDCLP.callStatic.balanceOf(autoCompoundCC.address)
        expect(autoCompoundCCLPBalanceBefore).to.equal(0)
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const userStakeBalanceBefore = await autoCompoundCC.callStatic.balanceOf(userAddress)

        const stakeAmount = ethers.utils.parseUnits("100000") // 100k DAI
        await dai.connect(user).approve(autoCompoundCC.address, stakeAmount)

        const isToken0 = true
        const tx = await autoCompoundCC.connect(user).stake(isToken0, stakeAmount, minReceivedLPAmount)
        const receipt = await tx.wait()

        const autoCompoundCCLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(autoCompoundCC.address)
        expect(autoCompoundCCLPBalanceAfter).to.equal(0)
        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const userStakeBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        const stakedAmount = autoCompoundCCStakeBalanceAfter.sub(autoCompoundCCStakeBalanceBefore)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with USDC", async () => {
        // const userDAIBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        // expect(userDAIBalanceBefore).to.be.gt(0)
        // const userUSDCBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        // expect(userUSDCBalanceBefore).to.be.gt(0)
        const userStakeBalanceBefore = await autoCompoundCC.callStatic.balanceOf(userAddress)

        const autoCompoundCCLPBalanceBefore = await cDAIcUSDCLP.callStatic.balanceOf(autoCompoundCC.address)
        expect(autoCompoundCCLPBalanceBefore).to.equal(0)
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)

        const stakeAmount = ethers.utils.parseUnits("100000", "mwei") // 100k USDC
        await usdc.connect(user).approve(autoCompoundCC.address, stakeAmount)

        const isToken0 = false
        const tx = await autoCompoundCC.connect(user).stake(isToken0, stakeAmount, minReceivedLPAmount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedLPAmount = await autoCompoundCC.callStatic.earned(userAddress)
        expect(earnedLPAmount).to.equal(0)
        // Should not accrue any LP tokens in AutoCompoundCurveConvex contract
        const autoCompoundCCLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(autoCompoundCC.address)
        expect(autoCompoundCCLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const stakedAmount = autoCompoundCCStakeBalanceAfter.sub(autoCompoundCCStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)

        // Add liquidity to get LP token
        const userLPAmountBefore = await cDAIcUSDCLP.callStatic.balanceOf(userAddress)
        const daiAddAmount = ethers.utils.parseUnits("100000")
        const usdcAddAmount = ethers.utils.parseUnits("100000", "mwei")
        await dai.connect(user).approve(curveDepositCompound.address, daiAddAmount)
        await usdc.connect(user).approve(curveDepositCompound.address, usdcAddAmount)
        const tokenAmounts = [
            daiAddAmount,
            usdcAddAmount
        ]
        await curveDepositCompound.connect(user).add_liquidity(tokenAmounts, minReceivedLPAmount)
        const userLPAmountAfter = await cDAIcUSDCLP.callStatic.balanceOf(userAddress)
        const lpAmount = userLPAmountAfter.sub(userLPAmountBefore)

        // LP token amount
        const stakeAmount = lpAmount
        await cDAIcUSDCLP.connect(user).approve(autoCompoundCC.address, stakeAmount)

        const tx = await autoCompoundCC.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const stakedAmount = autoCompoundCCStakeBalanceAfter.sub(autoCompoundCCStakeBalanceBefore)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should not earned before compound", async () => {
        const earnedLPAmountBefore = await autoCompoundCC.callStatic.earned(userAddress)
        expect(earnedLPAmountBefore).to.equal(0)

        ffSeconds = 1000
        await fastforward(ffSeconds)

        const earnedLPAmountAfter = await autoCompoundCC.callStatic.earned(userAddress)
        expect(earnedLPAmountAfter).to.equal(earnedLPAmountBefore)
    })

    it("Should compound", async () => {
        const userBalanceBefore = await autoCompoundCC.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await autoCompoundCC.callStatic._share(userAddress)
        const userEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(userAddress)

        const totalSupplyBefore = await autoCompoundCC.callStatic.totalSupply()
        const lpAmountCompoundedBefore = await autoCompoundCC.callStatic.lpAmountCompounded()
        const totalRewardShareBefore = await autoCompoundCC.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const autoCompoundCCEarnedRewardsBefore = await convexBaseRewardPool.callStatic.earned(autoCompoundCC.address)
        // Should have accrued reward to compound
        expect(autoCompoundCCEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        expect(totalRewardShareBefore).to.equal(autoCompoundCCEarnedRewardsBefore)
        // Should not earn any LP tokens before compound
        expect(userEarnedLPAmountBefore).to.equal(0)
        expect(totalEarnedLPAmountBefore).to.equal(0)

        const tx = await autoCompoundCC.connect(operator).compound(
            minReceivedToken0Amount,
            minReceivedToken0Amount,
            minReceivedLPAmount
        )
        const receipt = await tx.wait()
        const events = parseLogsByName(autoCompoundCC, "ConvertFailed", receipt.logs)
        for (const event of events) {
            console.log("ConvertFailed event")
            console.log(`fromToken: ${event.args.fromToken}`)
            console.log(`toToken: ${event.args.toToken}`)
            console.log(`fromAmount: ${event.args.fromAmount.toString()}`)
            console.log(`reason: ${event.args.reason}`)
            console.log(`lowLevelData: ${event.args.lowLevelData}`)
        }

        // Should not change User's balance and total supply
        const userBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        expect(userBalanceAfter).to.equal(userBalanceBefore)
        const totalSupplyAfter = await autoCompoundCC.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should match amount compounded and balance increase of AutoCompoundCurveConvex 
        const lpAmountCompoundedAfter = await autoCompoundCC.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        expect(autoCompoundCCStakeBalanceAfter.sub(autoCompoundCCStakeBalanceBefore)).to.equal(compoundedAmount)
        // Should be no rewards left
        const autoCompoundCCEarnedRewardsAfter = await convexBaseRewardPool.callStatic.earned(autoCompoundCC.address)
        expect(autoCompoundCCEarnedRewardsAfter).to.equal(0)
        const userRewardShareAfter = await autoCompoundCC.callStatic._share(userAddress)
        const userEarnedLPAmountAfter = await autoCompoundCC.callStatic.earned(userAddress)
        const totalRewardShareAfter = await autoCompoundCC.callStatic._shareTotal()
        const totalEarnedLPAmountAfter = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareAfter).to.equal(userRewardShareAfter)
        // Assume no one else staking: user earned LP amount should be the same as total earned LP amount
        expect(totalEarnedLPAmountAfter).to.equal(userEarnedLPAmountAfter)
        // Should match total earned LP amount and compounded amount
        expect(totalEarnedLPAmountAfter).to.equal(compoundedAmount)
        
        const rewardsAmount = autoCompoundCCEarnedRewardsBefore
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
        const earnedLPAmountBefore = await autoCompoundCC.callStatic.earned(userAddress)

        const earnedRewards = ethers.utils.formatUnits(
            earnedLPAmountBefore,
            18
        )
        console.log(`Earned ${earnedRewards} rewards in ${ffSeconds} seconds`)
    })

    it("Should withdraw and convert to DAI", async () => {
        const userDAIBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        const userStakeBalanceBefore = await autoCompoundCC.callStatic.balanceOf(userAddress)

        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)

        const withdrawAmount = ethers.utils.parseUnits("5")

        const toToken0 = true
        const tx = await autoCompoundCC.connect(user).withdraw(toToken0, minReceivedToken0Amount, withdrawAmount)
        const receipt = await tx.wait()

        const userDAIBalanceAfter = await dai.callStatic.balanceOf(userAddress)
        // Should receive withdrawal
        expect(userDAIBalanceAfter).to.be.gt(userDAIBalanceBefore)
        const userStakeBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const totalEarnedLPAmountAfter = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        // Should match AutoCompoundCurveConvex balance difference and user withdraw amount
        expect(autoCompoundCCStakeBalanceBefore.sub(autoCompoundCCStakeBalanceAfter)).to.equal(withdrawAmount)
        // Assume no one else staking: AutoCompoundCurveConvex balance should be the same as user balance plus total compounded LP amount
        expect(autoCompoundCCStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))

        const withdrew = ethers.utils.formatUnits(
            withdrawAmount,
            18
        )

        console.log(`Withdrew ${withdrew} LP`)
        const receivedDAI = ethers.utils.formatUnits(
            userDAIBalanceAfter.sub(userDAIBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedDAI} DAI`)
    })

    it("Should withdraw with LP Token", async () => {
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await autoCompoundCC.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        const withdrawnAmount = autoCompoundCCStakeBalanceBefore.sub(autoCompoundCCStakeBalanceAfter)
        expect(withdrawnAmount).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
    })

    it("Should getReward and convert to BCNT", async () => {
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await autoCompoundCC.callStatic._share(userAddress)
        const userEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(userAddress)
        const userStakeBalanceBefore = await autoCompoundCC.callStatic.balanceOf(userAddress)

        const totalRewardShareBefore = await autoCompoundCC.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        const lpAmountCompoundedBefore = await autoCompoundCC.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)
        const autoCompoundCCStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)

        const toToken0 = true
        const tx = await autoCompoundCC.connect(user).getReward(minReceivedToken0Amount, minReceivedBCNTAmount)
        const receipt = await tx.wait()

        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        // Should receive reward
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userStakeBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await autoCompoundCC.callStatic._share(userAddress)
        const totalRewardShareAfter = await autoCompoundCC.callStatic._shareTotal()
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        // Assume no one else staking: should have no rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const totalEarnedLPAmountAfter = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        const lpAmountCompoundedAfter = await autoCompoundCC.callStatic.lpAmountCompounded()
        const receivedCompoundedLPAmount = lpAmountCompoundedBefore.sub(lpAmountCompoundedAfter)
        // Should receive compounded LP
        expect(receivedCompoundedLPAmount).to.equal(lpAmountCompoundedBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))

        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        // Should match the stake balance difference and received LP amount
        expect(autoCompoundCCStakeBalanceAfter).to.equal(autoCompoundCCStakeBalanceBefore.sub(receivedCompoundedLPAmount))
        // Assume no one else staking: AutoCompoundCurveConvex balance should be the same as user balance plus total compounded LP amount
        expect(autoCompoundCCStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Get ${receivedCompoundedLP} reward LP`)
        const receivedBCNT = ethers.utils.formatUnits(
            userBCNTBalanceAfter.sub(userBCNTBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedBCNT} BCNT`)
    })

    it("Should compound", async () => {
        // Fast forward sometime, accrue some reward
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const lpAmountCompoundedBefore = await autoCompoundCC.callStatic.lpAmountCompounded()
        const autoCompoundCCEarnedRewardsBefore = await convexBaseRewardPool.callStatic.earned(autoCompoundCC.address)

        const tx = await autoCompoundCC.connect(operator).compound(
            minReceivedToken0Amount,
            minReceivedToken0Amount,
            minReceivedLPAmount
        )
        const receipt = await tx.wait()
        const events = parseLogsByName(autoCompoundCC, "ConvertFailed", receipt.logs)
        for (const event of events) {
            console.log("ConvertFailed event")
            console.log(`fromToken: ${event.args.fromToken}`)
            console.log(`toToken: ${event.args.toToken}`)
            console.log(`fromAmount: ${event.args.fromAmount.toString()}`)
            console.log(`reason: ${event.args.reason}`)
            console.log(`lowLevelData: ${event.args.lowLevelData}`)
        }

        // Should match amount compounded and balance increase of AutoCompoundCurveConvex 
        const lpAmountCompoundedAfter = await autoCompoundCC.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        
        const rewardsAmount = autoCompoundCCEarnedRewardsBefore
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

    it("Should exit and convert to USDC and BCNT", async () => {
        const userUSDCBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await autoCompoundCC.callStatic._share(userAddress)
        const userEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(userAddress)

        const totalRewardShareBefore = await autoCompoundCC.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await autoCompoundCC.callStatic.earned(autoCompoundCC.address)
        const lpAmountCompoundedBefore = await autoCompoundCC.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)

        const toToken0 = false
        const tx = await autoCompoundCC.connect(user).exit(toToken0, minReceivedToken0Amount, minReceivedBCNTAmount)
        // const tx = await autoCompoundCC.connect(user).exitWithLP(minReceivedToken0Amount, minReceivedBCNTAmount)
        const receipt = await tx.wait()
        const events = parseLogsByName(autoCompoundCC, "ConvertFailed", receipt.logs)
        for (const event of events) {
            console.log("ConvertFailed event")
            console.log(`fromToken: ${event.args.fromToken}`)
            console.log(`toToken: ${event.args.toToken}`)
            console.log(`fromAmount: ${event.args.fromAmount.toString()}`)
            console.log(`reason: ${event.args.reason}`)
            console.log(`lowLevelData: ${event.args.lowLevelData}`)
        }

        const userUSDCalanceAfter = await usdc.callStatic.balanceOf(userAddress)
        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        // Should receive withdrawal
        expect(userUSDCalanceAfter).to.be.gt(userUSDCBalanceBefore)
        // Should receive reward
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userStakeBalanceAfter = await autoCompoundCC.callStatic.balanceOf(userAddress)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await autoCompoundCC.callStatic._share(userAddress)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await autoCompoundCC.callStatic._shareTotal()
        // Assume no one else staking: should be no total earned rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const lpAmountCompoundedAfter = await autoCompoundCC.callStatic.lpAmountCompounded()
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
        const autoCompoundCCLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(autoCompoundCC.address)
        // Should not accrue any LP tokens in AutoCompoundCurveConvex contract
        expect(autoCompoundCCLPBalanceAfter).to.equal(0)
        const autoCompoundCCStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(autoCompoundCC.address)
        // Assume no one else staking: should be no AutoCompoundCurveConvex balance left
        expect(autoCompoundCCStakeBalanceAfter).to.equal(0)

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Exit and get ${receivedCompoundedLP} extra LP`)
        const receivedUSDC = ethers.utils.formatUnits(
            userUSDCalanceAfter.sub(userUSDCBalanceBefore),
            18
        )
        console.log(`LP converted to ${receivedUSDC} USDC`)
        const receivedBCNT = ethers.utils.formatUnits(
            userBCNTBalanceAfter.sub(userBCNTBalanceBefore),
            18
        )
        console.log(`Reward converted to ${receivedBCNT} BCNT`)
    })
})