pragma solidity >=0.5.0 <0.9.0;
import "./IPancakePair.sol";

interface IConverter {
    function convert(
        address _inTokenAddress,
        uint256 _amount,
        uint256 _convertPercentage,
        address _outTokenAddress,
        uint256 _minReceiveAmount,
        address _recipient
    ) external;
    function convertAndAddLiquidity(address _inTokenAddress, uint256 _amount, address _outTokenAddress, uint256 _minReceiveAmount, address _recipient) external;
    function removeLiquidityAndConvert(IPancakePair _lp, uint256 _lpAmount, uint256 _token0Percentage, address _recipient) external;
}