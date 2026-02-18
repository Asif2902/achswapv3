import { z } from "zod";

// Token schema for the token list
export const tokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number(),
  logoURI: z.string(),
  verified: z.boolean().default(false),
  chainId: z.number(),
});

export type Token = z.infer<typeof tokenSchema>;

// Imported token schema for localStorage
export const importedTokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number(),
  timestamp: z.number(),
});

export type ImportedToken = z.infer<typeof importedTokenSchema>;

// Liquidity position schema
export const liquidityPositionSchema = z.object({
  id: z.string(),
  tokenA: z.string(),
  tokenB: z.string(),
  amountA: z.string(),
  amountB: z.string(),
  lpTokens: z.string(),
  shareOfPool: z.number(),
});

export type LiquidityPosition = z.infer<typeof liquidityPositionSchema>;
