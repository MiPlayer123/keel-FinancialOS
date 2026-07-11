interface AmountToken {
  readonly start: number;
  readonly end: number;
  readonly lexeme: string;
  readonly numeric: boolean;
}

const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

const endOfJsonString = (text: string, start: number): number => {
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }

  throw new SyntaxError('unterminated JSON string');
};

const decodeJsonString = (token: string): string => {
  const decoded: unknown = JSON.parse(token) as unknown;
  if (typeof decoded !== 'string') {
    throw new SyntaxError('expected JSON string');
  }
  return decoded;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
};

const findAmountTokens = (rawText: string): AmountToken[] => {
  const tokens: AmountToken[] = [];
  let index = 0;

  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      index += 1;
      continue;
    }

    const keyEnd = endOfJsonString(rawText, index);
    const key = decodeJsonString(rawText.slice(index, keyEnd));
    let valueStart = skipWhitespace(rawText, keyEnd);

    if (key !== 'amount' || rawText[valueStart] !== ':') {
      index = keyEnd;
      continue;
    }

    valueStart = skipWhitespace(rawText, valueStart + 1);
    if (rawText[valueStart] === '"') {
      const valueEnd = endOfJsonString(rawText, valueStart);
      tokens.push({
        start: valueStart,
        end: valueEnd,
        lexeme: decodeJsonString(rawText.slice(valueStart, valueEnd)),
        numeric: false,
      });
      index = valueEnd;
      continue;
    }

    NUMBER_PATTERN.lastIndex = valueStart;
    const match = NUMBER_PATTERN.exec(rawText);
    if (match !== null) {
      tokens.push({
        start: valueStart,
        end: NUMBER_PATTERN.lastIndex,
        lexeme: match[0],
        numeric: true,
      });
      index = NUMBER_PATTERN.lastIndex;
      continue;
    }

    index = keyEnd;
  }

  return tokens;
};

/** Return every Plaid `amount` value from raw JSON as its exact decimal lexeme. */
export const extractAmountLexemes = (rawText: string): string[] =>
  findAmountTokens(rawText).map(({ lexeme }) => lexeme);

/**
 * Parse raw Plaid JSON only after rewriting numeric `amount` tokens to JSON
 * strings. Thus transaction money never passes through JavaScript Number.
 */
export const parsePlaidJsonPreservingAmountLexemes = (rawText: string): unknown => {
  const numericTokens = findAmountTokens(rawText).filter(({ numeric }) => numeric);
  let protectedText = rawText;

  for (const token of numericTokens.reverse()) {
    protectedText = `${protectedText.slice(0, token.start)}${JSON.stringify(token.lexeme)}${protectedText.slice(token.end)}`;
  }

  return JSON.parse(protectedText) as unknown;
};
