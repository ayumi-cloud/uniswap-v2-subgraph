/* eslint-disable prefer-const */
import { Address } from '@graphprotocol/graph-ts'

import { ZERO_BD, fetchTokenName, fetchTokenSymbol, fetchTokenDecimals } from '../helpers'

import { PairCreated } from '../types/Factory/Factory'
import { Uniswap, Token, Pair } from '../types/schema'
import { Pair as PairTemplate } from '../types/templates'

export function handlePairCreated(event: PairCreated): void {
  let uniswap = Uniswap.load('0xe2f197885abe8ec7c866cff76605fd06d4576218')

  // create and save Uniswap if needed
  if (uniswap === null) {
    uniswap = new Uniswap('0xe2f197885abe8ec7c866cff76605fd06d4576218')
    uniswap.pairs = []
    uniswap.pairCount = 0
    uniswap.save()
  }

  let token0 = Token.load(event.params.token0.toHexString())
  let token1 = Token.load(event.params.token1.toHexString())

  // create and save Token0 if needed
  if (token0 === null) {
    token0 = new Token(event.params.token0.toHexString())
    token0.name = fetchTokenName(event.params.token0)
    token0.symbol = fetchTokenSymbol(event.params.token0)
    token0.decimals = fetchTokenDecimals(event.params.token0)
    token0.pairs = []
    // bail if we couldn't figure out the decimals
    if (token0.decimals === null) {
      return
    }
    token0.save()
  }

  // create and save Token1 if needed
  if (token1 === null) {
    token1 = new Token(event.params.token1.toHexString())
    token1.name = fetchTokenName(event.params.token1)
    token1.symbol = fetchTokenSymbol(event.params.token1)
    token1.decimals = fetchTokenDecimals(event.params.token1)
    token0.pairs = []
    // bail if we couldn't figure out the decimals
    if (token1.decimals === null) {
      return
    }
    token1.save()
  }

  // create the Pair and save
  let pair = new Pair(event.params.pair.toHexString())
  pair.token0 = token0.id
  pair.token1 = token1.id
  pair.reserve0 = ZERO_BD
  pair.reserve1 = ZERO_BD
  pair.totalSupply = ZERO_BD
  pair.createdAtBlockNumber = event.block.number
  pair.createdAtTimestamp = event.block.timestamp
  pair.save()

  // update Uniswap and save
  let nextPairs = uniswap.pairs
  nextPairs.push(pair.id)
  uniswap.pairs = nextPairs
  uniswap.pairCount = uniswap.pairCount + 1
  uniswap.save()

  // update Tokens and save
  let WETHAddress = Address.fromString('0xc778417e063141139fce010982780140aa0cd5ab')
  if (event.params.token0 === WETHAddress) {
    token1.WETHPair = pair.id
  } else if (event.params.token1 === WETHAddress) {
    token0.WETHPair = pair.id
  }
  let nextPairsToken0 = token0.pairs
  nextPairsToken0.push(pair.id)
  token0.pairs = nextPairsToken0
  let nextPairsToken1 = token1.pairs
  nextPairsToken1.push(pair.id)
  token1.pairs = nextPairsToken1
  token0.save()
  token1.save()

  PairTemplate.create(event.params.pair)
}
