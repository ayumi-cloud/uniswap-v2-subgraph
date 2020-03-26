/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, EthereumEventParam } from '@graphprotocol/graph-ts'

import { convertTokenToDecimal, ONE_BI, ZERO_BD, equalToZero, ADDRESS_ZERO } from '../helpers'
// import {
//   updateUniswapHistoricalData,
//   updateExchangeHistoricalData,
//   updateTokenHistoricalData,
// } from './historicalUpdates'
// import { updateExchangeDayData, updateTokenDayData, updateUniswapDayData } from './dayUpdates'
// import { getEthPriceInUSD } from './priceOracle'

import {
  Pair,
  Token,
  Uniswap,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
} from '../types/schema'
import { Mint, Burn, Swap, Sync, Transfer } from '../types/templates/Pair/Pair'

// function updateCounters(): void {
//   let uniswap = Uniswap.load('0xe2f197885abe8ec7c866cff76605fd06d4576218')
//   uniswap.exchangeHistoryEntityCount = uniswap.exchangeHistoryEntityCount.plus(ONE_BI)
//   uniswap.uniswapHistoryEntityCount = uniswap.uniswapHistoryEntityCount.plus(ONE_BI)
//   uniswap.tokenHistoryEntityCount = uniswap.tokenHistoryEntityCount.plus(ONE_BI)
//   uniswap.reserveEntityCount = uniswap.reserveEntityCount.plus(ONE_BI)
//   uniswap.txCount = uniswap.txCount.plus(ONE_BI)
//   uniswap.save()
// }

// /**
//  * Search through graph to find derived Eth per token.
//  * @todo update to be derived ETH (add stablecoin estimates)
//  *
//  **/
// function findEthPerToken(token: Token, maxDepthReached: boolean): BigDecimal {
//   if (token.WETHPair != null) {
//     let WETHPair = Pair.load(token.WETHPair)
//     if (WETHPair.token0 == token.id) {
//       // our token is token 0
//       return WETHPair.token1Price
//     } else {
//       // our token is token 1
//       return WETHPair.token0Price
//     }
//   } else if (!maxDepthReached) {
//     let allPairs = token.allPairs as Array<string>
//     for (let i = 0; i < allPairs.length; i++) {
//       let currentExchange = Pair.load(allPairs[i])
//       if (currentExchange.token0 == token.id) {
//         // our token is token 0
//         let otherToken = Token.load(currentExchange.token1)
//         let otherTokenEthPrice = findEthPerToken(otherToken as Token, true)
//         if (otherTokenEthPrice != null) {
//           return currentExchange.token1Price.times(otherTokenEthPrice)
//         }
//       } else {
//         // our token is token 1
//         let otherToken = Token.load(currentExchange.token0)
//         let otherTokenEthPrice = findEthPerToken(otherToken as Token, true)
//         if (otherTokenEthPrice != null) {
//           return currentExchange.token0Price.times(otherTokenEthPrice)
//         }
//       }
//     }
//   }
//   return ZERO_BD /** @todo may want to return null */
// }

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId).sender !== null // sufficient checks
}

/**
 * Both mint and burn have at least one transfer event, and an optional second,
 * both of which occur before the final Burn or Mint event.
 *
 * To handle this, we create optional fields in the mint and burn entities.
 * If we find a case with two transfers, we overwrite old values.
 *
 * 1. if mint, create new mint entity if needed
 * 2. same for burn
 * 3. in both bases, if the last entity in array is complete then we know
 *    that we must be on the second transfer in the order. In this case,
 *    overwrite the old values and shift them to "fee" slots (because first
 *    transfer must have been the fee transfer).
 */
export function handleTransfer(event: Transfer): void {
  let pair = Pair.load(event.address.toHexString())

  let value = convertTokenToDecimal(event.params.value, 18)

  // create and save Transaction if needed
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
    transaction.save()
  }

  let mints = transaction.mints
  // mint
  if (event.params.from.toHexString() === ADDRESS_ZERO) {
    // increment totalSupply
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()
    // this is the start of a new instance of a logical mint _OR_ a logical burn for this transaction
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(mints.length).toString())
      )
      mint.pair = pair.id
      mint.to = event.params.to
      mint.liquidity = value
      mint.save()
      // update the transaction
      mints.push(mint.id)
      transaction.mints = mints
      transaction.save()
    }
    // this is the second Mint event of a logical mint
    else {
      // this attributes the initial MINIMUM_LIQUIDITY as fee liquidity to address(0)
      let mint = MintEvent.load(mints[mints.length - 1])
      mint.feeTo = mint.to
      mint.feeLiquidity = mint.liquidity
      mint.to = event.params.to
      mint.liquidity = value
      mint.save()
    }
  }
  // burn
  else if (event.params.to.toHexString() === ADDRESS_ZERO && event.params.from.toHexString() === pair.id) {
    // decrement totalSupply
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()
    // this is a new instance of a logical burn
    let burns = transaction.burns
    let burn = new BurnEvent(
      event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(burns.length).toString())
    )
    burn.pair = pair.id
    burn.liquidity = value
    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1])
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // TODO test
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])
      // update the transaction
      mints.pop()
      transaction.mints = mints
      transaction.save()
    }
    burn.save()
    // update the transaction
    burns.push(burn.id)
    transaction.burns = burns
    transaction.save()
  }
  // todo: handle normal transfer logic
  else {
  }
}

export function handleMint(event: Mint): void {
  // let uniswap = Uniswap.load('0xe2f197885abe8ec7c866cff76605fd06d4576218')
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  let mints = transaction.mints
  let mint = MintEvent.load(mints[mints.length - 1])

  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  mint.sender = event.params.sender
  mint.amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  mint.amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  mint.save()
  // update exchange info (except balances, sync will cover that)
  // let token0Amount =
  // let token1Amount =
  // pair.token0Price = pair.token0Balance.div(pair.token1Balance).truncate(18)
  // pair.token1Price = pair.token1Balance.div(pair.token0Balance).truncate(18)
  // pair.totalTxsCount = pair.totalTxsCount.plus(ONE_BI)
  // pair.save()

  // // ETH/USD prices
  // let bundle = Bundle.load('1')
  // bundle.ethPrice = getEthPriceInUSD(event.block.number)
  // bundle.save()

  // // update global token0 info
  // let ethPerToken0 = findEthPerToken(token0 as Token, false)
  // let usdPerToken0 = bundle.ethPrice.times(ethPerToken0)
  // token0.derivedETH = ethPerToken0
  // token0.totalLiquidityToken = token0.totalLiquidityToken.plus(token0Amount)
  // token0.totalLiquidityETH = token0.totalLiquidityToken.times(ethPerToken0)

  // // update global token1 info
  // let ethPerToken1 = findEthPerToken(token1 as Token, false)
  // let usdPerToken1 = bundle.ethPrice.times(ethPerToken1)
  // token1.derivedETH = ethPerToken1
  // token1.totalLiquidityToken = token1.totalLiquidityToken.plus(token1Amount)
  // token1.totalLiquidityETH = token1.totalLiquidityToken.times(ethPerToken1)

  // // get new amounts of USD and ETH for tracking
  // let amountTotalETH = ethPerToken1.times(token1Amount).plus(ethPerToken0.times(token0Amount))
  // let amountTotalUSD = usdPerToken1.times(token1Amount).plus(usdPerToken0.times(token0Amount))

  // // update global liquidity
  // uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(amountTotalETH)
  // uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice)

  // // update exchange liquidity
  // pair.combinedBalanceETH = pair.combinedBalanceETH.plus(amountTotalETH)
  // token0.save()
  // token1.save()
  // pair.save()
  // uniswap.save()

  // // now we know we can complete mint event that was created during transfer
  // let mintId = uniswap.mintCount.toString()
  // let mintEvent = MintEvent.load(mintId)
  // mintEvent.sender = event.params.sender
  // mintEvent.pair = pair.id
  // mintEvent.token0 = token0.id
  // mintEvent.token1 = token1.id
  // mintEvent.valueUSD = amountTotalUSD
  // mintEvent.valueETH = amountTotalETH
  // mintEvent.amount0 = token0Amount
  // mintEvent.amount1 = token1Amount
  // let newReserves = new Reserve(uniswap.reserveEntityCount.toString())
  // newReserves.reserve0 = pair.token0Balance.minus(token0Amount) as BigDecimal
  // newReserves.reserve1 = pair.token1Balance.minus(token1Amount) as BigDecimal
  // newReserves.save()
  // mintEvent.reservesPre = newReserves.id
  // mintEvent.save()

  // // update counters
  // updateCounters()

  // // update historical entities
  // updateUniswapHistoricalData(event)
  // updateExchangeHistoricalData(event, 'mint')
  // updateTokenHistoricalData(token0 as Token, event)
  // updateTokenHistoricalData(token1 as Token, event)

  // // update day entities
  // updateExchangeDayData(event)
  // updateUniswapDayData(event)
  // updateTokenDayData(token0 as Token, event)
  // updateTokenDayData(token1 as Token, event)
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  let burns = transaction.burns
  let burn = BurnEvent.load(burns[burns.length - 1])

  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  burn.sender = event.params.sender
  burn.amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  burn.amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
  burn.to = event.params.to
  burn.save()

  // let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  // let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // // need to avoid div by 0, check balances first
  // if (!equalToZero(pair.token1Balance)) {
  //   pair.token0Price = pair.token0Balance.div(pair.token1Balance).truncate(18)
  // } else {
  //   pair.token0Price = ZERO_BD
  // }
  // if (!equalToZero(pair.token0Balance)) {
  //   pair.token1Price = pair.token1Balance.div(pair.token0Balance).truncate(18)
  // } else {
  //   pair.token1Price = ZERO_BD
  // }
  // pair.totalTxsCount = pair.totalTxsCount.plus(ONE_BI)

  // //ETH / USD prices
  // let bundle = Bundle.load('1')
  // let ethPriceInUSD = getEthPriceInUSD(event.block.number)
  // bundle.ethPrice = ethPriceInUSD
  // bundle.save()

  // // update global token0 info
  // let ethPerToken0 = findEthPerToken(token0 as Token, false)
  // let usdPerToken0 = bundle.ethPrice.times(ethPerToken0)
  // token0.derivedETH = ethPerToken0
  // token0.totalLiquidityToken = token0.totalLiquidityToken.minus(token0Amount)
  // token0.totalLiquidityETH = token0.totalLiquidityToken.times(ethPerToken0)

  // // update global token1 info
  // let ethPerToken1 = findEthPerToken(token1 as Token, false)
  // let usdPerToken1 = bundle.ethPrice.times(ethPerToken1)
  // token1.derivedETH = ethPerToken1
  // token1.totalLiquidityToken = token1.totalLiquidityToken.minus(token1Amount)
  // token1.totalLiquidityETH = token1.totalLiquidityToken.times(ethPerToken1)

  // // get new amounts of USD and ETH for tracking
  // let amountTotalETH = ethPerToken1.times(token1Amount).plus(ethPerToken0.times(token0Amount))
  // let amountTotalUSD = usdPerToken1.times(token1Amount).plus(usdPerToken0.times(token0Amount))

  // // update global liquidity
  // uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(amountTotalETH)
  // uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice)

  // // update global counter and save
  // pair.combinedBalanceETH = pair.combinedBalanceETH.minus(amountTotalETH)
  // token0.save()
  // token1.save()
  // pair.save()
  // uniswap.save()

  // // update the remaining values for mint
  // let burnId = uniswap.burnCount.toString()
  // let burnEvent = BurnEvent.load(burnId)
  // burnEvent.sender = event.params.sender
  // burnEvent.from = event.params.to
  // burnEvent.pair = pair.id
  // burnEvent.token0 = token0.id
  // burnEvent.token1 = token1.id
  // burnEvent.valueUSD = amountTotalUSD
  // burnEvent.valueETH = amountTotalETH
  // burnEvent.amount0 = token0Amount
  // burnEvent.amount1 = token1Amount
  // let newReserves = new Reserve(uniswap.reserveEntityCount.toString())
  // newReserves.reserve0 = pair.token0Balance.plus(token0Amount)
  // newReserves.reserve1 = pair.token1Balance.plus(token1Amount)
  // newReserves.save()
  // burnEvent.reservesPre = newReserves.id
  // burnEvent.save()

  // // update counters
  // updateCounters()

  // // update historical entities
  // updateUniswapHistoricalData(event)
  // updateExchangeHistoricalData(event, 'mint')
  // updateTokenHistoricalData(token0 as Token, event)
  // updateTokenHistoricalData(token1 as Token, event)

  // // update day entities
  // updateExchangeDayData(event)
  // updateUniswapDayData(event)
  // updateTokenDayData(token0 as Token, event)
  // updateTokenDayData(token1 as Token, event)
}

export function handleSync(event: Sync): void {
  // let uniswap = Uniswap.load('0xe2f197885abe8ec7c866cff76605fd06d4576218')

  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)
  pair.save()

  // protect against divide by 0
  // if (equalToZero(exchange.token0Balance)) {
  //   exchange.token1Price = ZERO_BD
  // } else {
  //   exchange.token1Price = exchange.token1Balance.div(exchange.token0Balance).truncate(18)
  // }
  // if (equalToZero(exchange.token1Balance)) {
  //   exchange.token0Price = ZERO_BD
  // } else {
  //   exchange.token0Price = exchange.token0Balance.div(exchange.token1Balance).truncate(18)
  // }
  // // update exchange values and save
  // exchange.tradeVolumeToken0 = exchange.tradeVolumeToken0.plus(token0Amount)
  // exchange.tradeVolumeToken1 = exchange.tradeVolumeToken0.plus(token1Amount)
  // exchange.totalTxsCount = exchange.totalTxsCount.plus(ONE_BI)
  // exchange.save()

  // let txn = event.transaction.hash.toHexString()
  // let transaction = Transaction.load(txn)
  // if (transaction !== null) {
  //   uniswap.reserveEntityCount = uniswap.reserveEntityCount.plus(ONE_BI)
  //   uniswap.save()
  //   let newReserves = new Reserve(uniswap.reserveEntityCount.toString())
  //   newReserves.reserve0 = amount0
  //   newReserves.reserve1 = amount1
  //   newReserves.save()
  //   let mints = transaction.mints
  //   if (mints.length > 0) {
  //     let latestMint = MintEvent.load(mints[mints.length - 1])
  //     if (latestMint.reservesPost === null) {
  //       latestMint.reservesPost = newReserves.id
  //       latestMint.save()
  //     }
  //   }
  //   let burns = transaction.burns
  //   if (burns.length > 0) {
  //     let latestBurn = BurnEvent.load(burns[burns.length - 1])
  //     if (latestBurn.reservesPost === null) {
  //       latestBurn.reservesPost = newReserves.id
  //       latestBurn.save()
  //     }
  //   }
  // } else {
  //   transaction = new Transaction(txn)
  //   transaction.block = event.block.number.toI32()
  //   transaction.timestamp = event.block.timestamp.toI32()
  //   transaction.mints = []
  //   transaction.swaps = []
  //   transaction.burns = []
  //   transaction.syncs = []
  // }
  // let newSyncs = transaction.syncs
  // let sync = new SyncEvent(uniswap.syncCount.toString())
  // uniswap.syncCount = uniswap.syncCount.plus(ONE_BI)
  // newSyncs.push(sync.id)
  // transaction.syncs = newSyncs
  // transaction.save()
  // // update with new values
  // exchange.token0Balance = amount0
  // exchange.token1Balance = amount1
  // exchange.save()
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // in theory we could parse event.transaction.input to detect flash swaps
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Out).plus(amount0In)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Out).plus(amount1In)
  pair.save()

  // create and save Transaction if needed
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
    transaction.save()
  }

  let swaps = transaction.swaps
  let swap = new SwapEvent(
    event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(swaps.length).toString())
  )
  swap.pair = pair.id
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to
  swap.save()
  // update the transaction
  swaps.push(swap.id)
  transaction.swaps = swaps
  transaction.save()

  // //ETH / USD prices
  // let bundle = Bundle.load('1')
  // let ethPriceInUSD = getEthPriceInUSD(event.block.number)
  // bundle.ethPrice = ethPriceInUSD
  // bundle.save()

  // let ethPerToken0 = findEthPerToken(token0 as Token, false)
  // let usdPerToken0 = bundle.ethPrice.times(ethPerToken0)
  // token0.derivedETH = ethPerToken0

  // let ethPerToken1 = findEthPerToken(token1 as Token, false)
  // let usdPerToken1 = bundle.ethPrice.times(ethPerToken1)
  // token1.derivedETH = ethPerToken1

  // // get new amounts of USD and ETH for tracking
  // let amountTotalETH = ethPerToken1.times(token1Amount).plus(ethPerToken0.times(token0Amount))
  // let amountTotalUSD = usdPerToken1.times(token1Amount).plus(usdPerToken0.times(token0Amount))

  // // update token0 volume and liquidity stats
  // token0.totalLiquidityToken = token0.totalLiquidityToken.plus(token0AmountSigned)
  // token0.totalLiquidityETH = token0.totalLiquidityToken.times(ethPerToken0)
  // token0.tradeVolumeToken = token0.tradeVolumeToken.plus(token0Amount)
  // token0.tradeVolumeETH = token0.tradeVolumeETH.plus(token0Amount.times(ethPerToken0))
  // token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(token0AmountSigned.times(usdPerToken0))

  // // update token1 volume and liquidity stats
  // token1.totalLiquidityToken = token1.totalLiquidityToken.plus(token1AmountSigned)
  // token1.totalLiquidityETH = token1.totalLiquidityToken.times(ethPerToken1)
  // token1.tradeVolumeToken = token1.tradeVolumeToken.plus(token1Amount)
  // token1.tradeVolumeETH = token1.tradeVolumeETH.plus(token1Amount.times(ethPerToken1))
  // token1.tradeVolumeUSD = token0.tradeVolumeUSD.plus(token1AmountSigned.times(usdPerToken1))

  // // update exchange volume data
  // exchange.tradeVolumeETH = exchange.tradeVolumeETH.plus(amountTotalETH)
  // exchange.tradeVolumeUSD = exchange.tradeVolumeUSD.plus(amountTotalUSD)
  // exchange.combinedBalanceETH = exchange.combinedBalanceETH
  //   .plus(token0AmountSigned.times(ethPerToken0))
  //   .plus(token1AmountSigned.times(ethPerToken1))

  // // update global values
  // let uniswap = Uniswap.load('0xe2f197885abe8ec7c866cff76605fd06d4576218')
  // uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(amountTotalUSD)
  // uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(amountTotalETH)

  // // save entities
  // exchange.save()
  // token0.save()
  // token1.save()
  // uniswap.save()

  // // update counters
  // updateCounters()

  // // update historical entities
  // updateUniswapHistoricalData(event)
  // updateExchangeHistoricalData(event, 'swap')
  // updateTokenHistoricalData(token0 as Token, event)
  // updateTokenHistoricalData(token1 as Token, event)

  // // update day entities
  // updateExchangeDayData(event)
  // updateUniswapDayData(event)
  // updateTokenDayData(token0 as Token, event)
  // updateTokenDayData(token1 as Token, event)

  // // get ids for date related entities
  // let timestamp = event.block.timestamp.toI32()
  // let dayID = timestamp / 86400
  // let dayExchangeID = event.address.toHexString().concat('-').concat(BigInt.fromI32(dayID).toString())

  // // swap specific updating
  // let uniswapDayData = UniswapDayData.load(dayID.toString())
  // uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(amountTotalUSD)
  // uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(amountTotalETH)
  // uniswapDayData.save()

  // // swap specific updating
  // let exchangeDayData = ExchangeDayData.load(dayExchangeID)
  // exchangeDayData.dailyVolumeToken0 = exchangeDayData.dailyVolumeToken0.plus(token0Amount)
  // exchangeDayData.dailyVolumeToken1 = exchangeDayData.dailyVolumeToken1.plus(token1Amount)
  // exchangeDayData.dailyVolumeUSD = exchangeDayData.dailyVolumeUSD.plus(amountTotalUSD)
  // exchangeDayData.save()

  // // swap specific updating
  // let token0DayID = token0.id.toString().concat('-').concat(BigInt.fromI32(dayID).toString())
  // let token0DayData = TokenDayData.load(token0DayID)
  // token0DayData = TokenDayData.load(token0DayID)
  // token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(token0Amount)
  // token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(token0Amount.times(ethPerToken0))
  // token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
  //   token0Amount.times(ethPerToken0).times(bundle.ethPrice)
  // )
  // token0DayData.save()

  // // swap specific updating
  // let token1DayID = token1.id.toString().concat('-').concat(BigInt.fromI32(dayID).toString())
  // let token1DayData = TokenDayData.load(token1DayID)
  // token1DayData = TokenDayData.load(token1DayID)
  // token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(token1Amount)
  // token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(token1Amount.times(ethPerToken1))
  // token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
  //   token1Amount.times(ethPerToken1).times(bundle.ethPrice)
  // )
  // token1DayData.save()
}
