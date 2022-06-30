pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IPancakePair.sol";
import "./interfaces/IPancakeRouter.sol";

contract Owned {
    using SafeERC20 for IERC20;

    address public owner;
    address public nominatedOwner;

    function initializeOwner(address _owner) internal {
        require(owner == address(0), "Already initialized");
        require(_owner != address(0), "Owner address cannot be 0");
        owner = _owner;
        emit OwnerChanged(address(0), _owner);
    }

    function nominateNewOwner(address _owner) external onlyOwner {
        nominatedOwner = _owner;
        emit OwnerNominated(_owner);
    }

    function acceptOwnership() external {
        require(msg.sender == nominatedOwner, "You must be nominated before you can accept ownership");
        emit OwnerChanged(owner, nominatedOwner);
        owner = nominatedOwner;
        nominatedOwner = address(0);
    }

    modifier onlyOwner {
        _onlyOwner();
        _;
    }

    function _onlyOwner() private view {
        require(msg.sender == owner, "Only the contract owner may perform this action");
    }

    event OwnerNominated(address newOwner);
    event OwnerChanged(address oldOwner, address newOwner);
}

/// @title A token converter contract which helps convert from one token to another, or
/// convert token A to LP token of token A and specified token B.
/// @notice Converted tokens are sent to specified `recipient`. If there are remaing token A or B
/// after adding liquidity it will be sent back to msg.sender.
contract Converter is Owned, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    address public NATIVE_TOKEN;
    string public name;
    IPancakeRouter public router;

    function implementation() external view returns (address) {
        return _getImplementation();
    }

    function initialize(address _NATIVE_TOKEN, string memory _name, address _owner, IPancakeRouter _router) virtual external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializeOwner(_owner);

        NATIVE_TOKEN = _NATIVE_TOKEN;
        name = _name;
        router = _router;
    }

    function _swap(uint256 _swapAmount, uint256 _minReceiveAmount, address _in, address _out, address _recipient) internal returns (uint256) {
        if (_swapAmount == 0) return 0;

        IERC20(_in).safeApprove(address(router), _swapAmount);

        address[] memory path;
        if (_in == NATIVE_TOKEN || _out == NATIVE_TOKEN) {
            path = new address[](2);
            path[0] = _in;
            path[1] = _out;
        } else {
            path = new address[](3);
            path[0] = _in;
            path[1] = NATIVE_TOKEN;
            path[2] = _out;
        }
        uint256[] memory amounts = router.swapExactTokensForTokens(
            _swapAmount,
            _minReceiveAmount,
            path,
            _recipient,
            block.timestamp + 60
        );

        if (_in == NATIVE_TOKEN || _out == NATIVE_TOKEN) {
            return amounts[1]; // swapped amount
        } else {
            return amounts[2];
        }
    }

    /// @notice Convert specified amount of tokenIn to tokenOut and send both to recipient
    /// @param _inTokenAddress The address of tokenIn
    /// @param _amount The amount of tokenIn
    /// @param _convertPercentage The percentage of tokenIn amount to convert
    /// @param _outTokenAddress The address of tokenOut
    /// @param _minReceiveAmount The minimum amount of tokenOut expected to receive
    /// @param _recipient The recipient address of tokenOut
    function convert(address _inTokenAddress, uint256 _amount, uint256 _convertPercentage, address _outTokenAddress, uint256 _minReceiveAmount, address _recipient) external {
        require((0 <= _convertPercentage) && (_convertPercentage <= 100), "Invalid convert percentage");

        IERC20 tokenIn = IERC20(_inTokenAddress);

        // Transfer tokenIn from msg.sender
        tokenIn.safeTransferFrom(msg.sender, address(this), _amount);

        // Swap specified proportion of tokenIn for tokenOut
        uint256 swapAmount = _amount * _convertPercentage / 100;
        _swap(swapAmount, _minReceiveAmount, _inTokenAddress, _outTokenAddress, _recipient);

        // Return half of tokenIn
        tokenIn.safeTransfer(_recipient, (_amount - swapAmount));
    }

    function _addLiquidity(
        IERC20 tokenIn,
        uint256 _amountADesired,
        uint256 _amountAMin,
        IERC20 tokenOut,
        uint256 _amountBDesired,
        uint256 _amountBMin,
        address _to
    ) internal {
        tokenIn.safeApprove(address(router), _amountADesired);
        tokenOut.safeApprove(address(router), _amountBDesired);

        router.addLiquidity(
            address(tokenIn),
            address(tokenOut),
            _amountADesired,
            _amountBDesired,
            _amountAMin, // _amountAMin
            _amountBMin, // _amountBMin
            _to,
            block.timestamp + 60
        );

        tokenIn.safeApprove(address(router), 0);
        tokenOut.safeApprove(address(router), 0);
    }

    /// @notice Convert half of tokenIn to tokenOut, add both to liquidity pool and send LP token to recipient.
    // Return leftover tokenIn and tokenOut to msg.sender
    /// @param _inTokenAddress The address of tokenIn
    /// @param _amount The amount of tokenIn
    /// @param _outTokenAddress The address of tokenOut
    /// @param _minReceiveAmountSwap The minimum amount of tokenOut expected to receive when swapping inToken for outToken
    /// @param _minInTokenAmountAddLiq The minimum amount of tokenIn expected to add when adding liquidity
    /// @param _minOutTokenAmountAddLiq The minimum amount of tokenOut expected to add when adding liquidity
    /// @param _recipient The recipient address of LP token
    function convertAndAddLiquidity(
        address _inTokenAddress,
        uint256 _amount,
        address _outTokenAddress,
        uint256 _minReceiveAmountSwap,
        uint256 _minInTokenAmountAddLiq,
        uint256 _minOutTokenAmountAddLiq,
        address _recipient
    ) external {
        IERC20 tokenIn = IERC20(_inTokenAddress);
        IERC20 tokenOut = IERC20(_outTokenAddress);

        // Transfer tokenIn from msg.sender
        tokenIn.safeTransferFrom(msg.sender, address(this), _amount);

        // Swap half of tokenIn for tokenOut
        uint256 swapAmount = _amount / 2;
        uint256 swappedAmount = _swap(swapAmount, _minReceiveAmountSwap, _inTokenAddress, _outTokenAddress, address(this));

        _addLiquidity(
            tokenIn,
            (_amount - swapAmount),
            _minInTokenAmountAddLiq,
            tokenOut,
            swappedAmount,
            _minOutTokenAmountAddLiq,
            _recipient
        );

        // Return leftover token to msg.sender
        uint256 remainInBalance = tokenIn.balanceOf(address(this));
        if (remainInBalance > 0) tokenIn.safeTransfer(msg.sender, remainInBalance);
        uint256 remainOutBalance = tokenOut.balanceOf(address(this));
        if (remainOutBalance > 0) tokenOut.safeTransfer(msg.sender, remainOutBalance);
    }

    function _removeLiquidity(
        IERC20 _lp,
        IERC20 _token0,
        IERC20 _token1,
        uint256 _lpAmount,
        uint256 _minToken0Amount,
        uint256 _minToken1Amount,
        address _to
    ) internal returns (uint256, uint256) {
        _lp.safeApprove(address(router), _lpAmount);

        (uint256 amountToken0, uint256 amountToken1) = router.removeLiquidity(
            address(_token0),
            address(_token1),
            _lpAmount,
            _minToken0Amount, // _amountAMin
            _minToken1Amount, // _amountBMin
            _to,
            block.timestamp + 60
        );

        return (amountToken0, amountToken1);
    }

    /// @notice Remove liquidity and convert returned token0 to token1 or vice versa, and send both to recipient.
    /// @param _lp The LP pair
    /// @param _lpAmount The amount of LP token to remove
    /// @param _minToken0Amount The minimum amount of token0 received when removing liquidity
    /// @param _minToken1Amount The minimum amount of token1 received when removing liquidity
    /// @param _token0Percentage The percentage of token0 to preserve: 0~100. For example, 10 means
    /// it will convert token0 and token1 to 10:90 ratio
    /// @param _recipient The recipient address of token0 and token1
    function removeLiquidityAndConvert(
        IPancakePair _lp,
        uint256 _lpAmount,
        uint256 _minToken0Amount,
        uint256 _minToken1Amount,
        uint256 _token0Percentage,
        address _recipient
    ) external {
        require((0 <= _token0Percentage) && (_token0Percentage <= 100), "Invalid token0 percentage");

        IERC20 lp = IERC20(address(_lp));
        IERC20 token0 = IERC20(_lp.token0());
        IERC20 token1 = IERC20(_lp.token1());

        // Transfer LP token from msg.sender
        lp.safeTransferFrom(msg.sender, address(this), _lpAmount);
        (uint256 amountToken0, uint256 amountToken1) = _removeLiquidity(
            lp,
            token0,
            token1,
            _lpAmount,
            _minToken0Amount,
            _minToken1Amount,
            address(this)
        );

        // Swap specified proportion of token0 for token1
        address tokenIn;
        address tokenOut;
        uint256 swapAmount;
        if (_token0Percentage <= 50) {
            tokenIn = address(token0);
            tokenOut = address(token1);
            swapAmount = amountToken0 * (50 - _token0Percentage) / 50;
        } else {
            tokenIn = address(token1);
            tokenOut = address(token0);
            swapAmount = amountToken1 * (_token0Percentage - 50) / 50;
        }
        if (swapAmount > 0) {
            _swap(swapAmount, 0, tokenIn, tokenOut, _recipient);
        }

        uint256 remainInBalance = token0.balanceOf(address(this));
        if (remainInBalance > 0) token0.safeTransfer(_recipient, remainInBalance);
        uint256 remainOutBalance = token1.balanceOf(address(this));
        if (remainOutBalance > 0) token1.safeTransfer(_recipient, remainOutBalance);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {}
}