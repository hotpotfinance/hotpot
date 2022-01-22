pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./stubPancakePair.sol";

contract StubPancakeRouter {
    // string public name;

    uint256 constant private SLIP_BPS = 9999;
    uint256 constant private BPS = 10000;

    mapping(address => mapping(address => address)) public lpAddr;


    function _getLPAddr(address tokenA, address tokenB) internal returns (address) {
        if (lpAddr[tokenA][tokenB] != address(0)) return lpAddr[tokenA][tokenB];
        else if (lpAddr[tokenB][tokenA] != address(0)) return lpAddr[tokenB][tokenA];
        else revert("Pair not exist");
    }

    function setLPAddr(address tokenA, address tokenB, address lp) external {
        lpAddr[tokenA][tokenB] = lp;
    }

    function swapExactTokensForTokens(
        uint256 _amountIn,
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    ) external returns (uint256[] memory amounts) {
        uint256 amountOut = _amountIn * SLIP_BPS / BPS;
        // uint256 amountOut = _amountIn;
        require(amountOut > _amountOutMin, "StubPancakeRouter: not enough out amount");

        IERC20 inToken = IERC20(_path[0]);
        inToken.transferFrom(msg.sender, address(this), _amountIn);

        IERC20 outToken = IERC20(_path[_path.length - 1]);
        outToken.transfer(_to, amountOut);

        amounts = new uint256[](_path.length);
        for (uint256 i = 0; i < _path.length; i++) {
            amounts[i] = _amountIn;
        }
        amounts[_path.length - 1] = amountOut;
    }

    function addLiquidity(
        address _tokenA,
        address _tokenB,
        uint256 _amountADesired,
        uint256 _amountBDesired,
        uint256 _amountAMin,
        uint256 _amountBMin,
        address _to,
        uint256 _deadline
    ) external returns (
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    ) {
        IERC20 tokenA = IERC20(_tokenA);
        IERC20 tokenB = IERC20(_tokenB);

        tokenA.transferFrom(msg.sender, address(this), _amountADesired);
        tokenB.transferFrom(msg.sender, address(this), _amountBDesired);

        StubPancakePair lp = StubPancakePair(_getLPAddr(_tokenA, _tokenB));
        lp.mint(_to, _amountADesired + _amountBDesired);
    }

    function removeLiquidity(
        address _tokenA,
        address _tokenB,
        uint256 _liquidity,
        uint256 _amountAMin,
        uint256 _amountBMin,
        address _to,
        uint256 _deadline
    ) external returns (uint256 amountA, uint256 amountB) {
        IERC20 tokenA = IERC20(_tokenA);
        IERC20 tokenB = IERC20(_tokenB);

        StubPancakePair lp = StubPancakePair(_getLPAddr(_tokenA, _tokenB));

        lp.transferFrom(msg.sender, address(this), _liquidity);
        tokenA.transfer(_to, _liquidity / 2);
        tokenB.transfer(_to, _liquidity / 2);

        lp.burn(_liquidity);
    }
}