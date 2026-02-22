export interface ParsedError {
  userMessage: string
  rawError: string
}

const ERROR_MESSAGES: Record<string, string> = {
  "insufficient ETH": "Insufficient ETH balance for this transaction",
  "insufficient token balance": "Insufficient token balance",
  "insufficient liquidity": "Not enough liquidity in this pool",
  "insufficient amount": "Insufficient input amount",
  "exceeded allowance": "Token allowance exceeded. Please approve more tokens.",
  "user rejected": "Transaction was rejected by your wallet",
  "user rejected the request": "Transaction was rejected by your wallet",
  "execution reverted": "Transaction failed on the blockchain. Check your inputs.",
  "gas required exceeds allowance": "Not enough gas allowance. Try increasing gas limit.",
  "gas too low": "Gas estimate too low. Try increasing gas.",
  "nonce too low": "Transaction nonce is too low. Please try again.",
  "transaction underpriced": "Gas price is too low. Try increasing gas price.",
  "replacement transaction underpriced": "Transaction already pending. Wait for confirmation.",
  "network changed": "Network changed. Please try again.",
  "wallet connection failed": "Failed to connect to wallet",
  "timeout": "Request timed out. Please check your connection.",
  "invalid address": "Invalid token or wallet address",
  "token not found": "Token not found. Check the token address.",
  "price impact too high": "Price impact is too high. Try a smaller amount.",
  "slippage exceeded": "Slippage exceeded. Increase slippage tolerance or try again.",
  "zero liquidity": "Cannot remove zero liquidity",
  "invalid token amounts": "Invalid token amounts entered",
  "transfer amount exceeds balance": "Token balance is too low",
  "approve": "Please approve the token first",
  "allowance": "Insufficient allowance. Approve more tokens.",
  "deadline": "Transaction deadline exceeded",
  "price slippage": "Price changed significantly. Try again.",
}

const ERROR_CODE_MESSAGES: Record<string, string> = {
  "-32000": "Insufficient funds for transaction",
  "-32002": "Invalid transaction parameters",
  "-32603": "Internal error. Please try again.",
  "4001": "Transaction rejected by user",
  "4100": "Unauthorized request",
  "4900": "Disconnected from network",
  "4901": "Network changed",
}

export function parseError(error: unknown): ParsedError {
  let rawError = ""
  let userMessage = "Transaction failed. Please try again."

  if (typeof error === "string") {
    rawError = error
  } else if (error instanceof Error) {
    rawError = error.message
  } else if (error && typeof error === "object") {
    const anyError = error as Record<string, unknown>
    rawError = anyError.message as string ?? anyError.reason as string ?? JSON.stringify(error)
    
    if (anyError.code) {
      const codeStr = String(anyError.code)
      if (ERROR_CODE_MESSAGES[codeStr]) {
        userMessage = ERROR_CODE_MESSAGES[codeStr]
      }
    }
  }

  const lowerError = rawError.toLowerCase()

  for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
    if (lowerError.includes(key.toLowerCase())) {
      userMessage = message
      break
    }
  }

  if (!rawError) {
    try {
      const stringified = JSON.stringify(error)
      rawError = stringified ?? "<unserializable error>"
    } catch {
      rawError = error?.toString() ?? Object.prototype.toString.call(error) ?? "<unserializable error>"
    }
  }

  return {
    userMessage,
    rawError: String(rawError).trim(),
  }
}

export function getErrorForToast(error: unknown): { title: string; description: string; rawError: string } {
  const parsed = parseError(error)
  
  let title = "Transaction Failed"
  
  const lowerError = parsed.rawError.toLowerCase()
  const userRejectionPatterns = [
    "user rejected",
    "user denied",
    "user rejected the request",
    "user denied transaction",
    "rejected by user",
    "request rejected",
  ]
  const isUserRejection = userRejectionPatterns.some((pattern) => lowerError.includes(pattern))
  
  if (isUserRejection) {
    title = "Transaction Rejected"
  } else if (lowerError.includes("insufficient")) {
    title = "Insufficient Balance"
  } else if (lowerError.includes("allowance")) {
    title = "Allowance Required"
  } else if (lowerError.includes("gas")) {
    title = "Gas Issue"
  } else if (lowerError.includes("timeout")) {
    title = "Request Timeout"
  }

  return {
    title,
    description: parsed.userMessage,
    rawError: parsed.rawError,
  }
}
