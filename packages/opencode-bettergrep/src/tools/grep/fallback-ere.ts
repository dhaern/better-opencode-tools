/** Parser helpers for the conservative GNU grep ERE allowlist. */
function isAsciiLetter(char: string): boolean {
  return /^[A-Za-z]$/.test(char);
}

function isAsciiDigit(char: string): boolean {
  return /^[0-9]$/.test(char);
}

function isAsciiClassEndpoint(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char);
}

function isSameAsciiRangeClass(left: string, right: string): boolean {
  return (
    (isAsciiDigit(left) && isAsciiDigit(right)) ||
    (left >= 'a' && left <= 'z' && right >= 'a' && right <= 'z') ||
    (left >= 'A' && left <= 'Z' && right >= 'A' && right <= 'Z')
  );
}

function isSafeClassLiteral(char: string): boolean {
  return char >= ' ' && char <= '~' && !'[]\\&~^-'.includes(char);
}

function parseEreClass(
  pattern: string,
  start: number,
): { end: number; error?: string } {
  let index = start + 1;
  if (pattern[index] === '^') {
    index += 1;
  }

  let memberCount = 0;
  while (index < pattern.length && pattern[index] !== ']') {
    const char = pattern[index];

    if (char === '[') {
      return {
        end: index,
        error:
          'nested or POSIX character classes are not supported by the GNU grep fallback',
      };
    }

    if (char === '\\') {
      return {
        end: index,
        error:
          'escapes inside character classes are not supported by the GNU grep fallback',
      };
    }

    if (char === '-') {
      if (memberCount === 0 || pattern[index + 1] === ']') {
        memberCount += 1;
        index += 1;
        continue;
      }

      return {
        end: index,
        error:
          'character class ranges must use ASCII letter or digit endpoints in the GNU grep fallback',
      };
    }

    if (!isSafeClassLiteral(char)) {
      return {
        end: index,
        error:
          'character class syntax is outside the supported GNU grep subset',
      };
    }

    const next = pattern[index + 1];
    if (next === '-') {
      const endpoint = pattern[index + 2];
      if (
        endpoint !== undefined &&
        endpoint !== ']' &&
        isAsciiClassEndpoint(char) &&
        isAsciiClassEndpoint(endpoint) &&
        isSameAsciiRangeClass(char, endpoint) &&
        char <= endpoint
      ) {
        index += 3;
        memberCount += 1;
        continue;
      }

      if (endpoint !== ']') {
        return {
          end: index,
          error:
            'character class ranges must use ascending ASCII letter or digit endpoints in the GNU grep fallback',
        };
      }
    }

    memberCount += 1;
    index += 1;
  }

  if (index >= pattern.length) {
    return {
      end: index,
      error: 'unterminated character class cannot be reproduced by GNU grep',
    };
  }

  if (memberCount === 0) {
    return {
      end: index,
      error:
        'empty character classes are not supported by the GNU grep fallback',
    };
  }

  return { end: index + 1 };
}

function parseEreRepetition(
  pattern: string,
  start: number,
): { end: number; error?: string } {
  const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(start));
  if (!match) {
    return {
      end: start,
      error:
        'bounded repetition must use {n}, {n,}, or {n,m} in the GNU grep fallback',
    };
  }

  const minimum = Number(match[1]);
  const maximum =
    match[2] === undefined || match[2] === '' ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(minimum) ||
    (maximum !== undefined &&
      (!Number.isSafeInteger(maximum) || maximum < minimum))
  ) {
    return {
      end: start,
      error:
        'bounded repetition values must be ascending safe integers in the GNU grep fallback',
    };
  }

  return { end: start + match[0].length };
}

/**
 * Translates only a deliberately whitelisted ripgrep regex grammar to ERE.
 * Locale-bound classes, Unicode boundary escapes, multiline input, and
 * constructs without a verified GNU grep equivalent are rejected.
 */
export function translatePatternToEre(pattern: string): {
  ere?: string;
  error?: string;
} {
  let out = '';
  let index = 0;
  let groupDepth = 0;
  let expectAtom = true;
  let canQuantify = false;
  let atAlternativeStart = true;
  const controlEscapes: Record<string, string> = {
    t: '\t',
    r: '\r',
    f: '\f',
    v: '\v',
  };
  const literalEscapes = new Set([
    '.',
    '^',
    '$',
    '*',
    '+',
    '?',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '|',
    '\\',
    '-',
  ]);

  while (index < pattern.length) {
    const char = pattern[index];

    if (char < ' ' || char === '\x7f') {
      return {
        error:
          'control characters, including literal newlines, cannot be reproduced by the GNU grep fallback',
      };
    }

    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        return {
          error:
            'pattern ends with a dangling backslash and cannot be translated to GNU grep ERE',
        };
      }
      if (next === 'n') {
        return {
          error:
            '\\n cannot be reproduced by the GNU grep fallback (newlines separate patterns)',
        };
      }
      if (next < ' ' || next === '\x7f') {
        return {
          error:
            'escaped control characters cannot be reproduced by the GNU grep fallback',
        };
      }

      if (next in controlEscapes) {
        out += controlEscapes[next];
      } else if (literalEscapes.has(next)) {
        out += `\\${next}`;
      } else {
        return {
          error: `escape sequence \\${next} is outside the supported GNU grep subset`,
        };
      }
      index += 2;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '[') {
      const parsed = parseEreClass(pattern, index);
      if (parsed.error) return { error: parsed.error };
      out += pattern.slice(index, parsed.end);
      index = parsed.end;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '(') {
      groupDepth += 1;
      out += char;
      index += 1;
      expectAtom = true;
      canQuantify = false;
      atAlternativeStart = true;
      continue;
    }

    if (char === ')') {
      if (groupDepth === 0 || expectAtom) {
        return {
          error:
            'unbalanced or empty groups are not supported by the GNU grep fallback',
        };
      }
      groupDepth -= 1;
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '|') {
      if (expectAtom) {
        return {
          error:
            'empty alternations are not supported by the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = true;
      canQuantify = false;
      atAlternativeStart = true;
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      if (!canQuantify) {
        return {
          error:
            'quantifiers must follow an atom and cannot be possessive in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = false;
      continue;
    }

    if (char === '{') {
      if (!canQuantify) {
        return {
          error:
            'bounded repetitions must follow an atom in the GNU grep fallback',
        };
      }
      const repetition = parseEreRepetition(pattern, index);
      if (repetition.error) return { error: repetition.error };
      out += pattern.slice(index, repetition.end);
      index = repetition.end;
      canQuantify = false;
      continue;
    }

    if (char === '}' || char === ']') {
      return {
        error: `unbalanced ${char} cannot be reproduced by the GNU grep fallback`,
      };
    }

    if (char === '^') {
      if (!atAlternativeStart) {
        return {
          error:
            '^ is only supported at the beginning of an alternation in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = false;
      atAlternativeStart = false;
      continue;
    }

    if (char === '$') {
      const next = pattern[index + 1];
      if (expectAtom || (next !== undefined && next !== ')' && next !== '|')) {
        return {
          error:
            '$ is only supported at the end of an alternation in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      canQuantify = false;
      continue;
    }

    out += char;
    index += 1;
    expectAtom = false;
    canQuantify = true;
    atAlternativeStart = false;
  }

  if (groupDepth !== 0 || expectAtom) {
    return {
      error:
        'unterminated group or empty alternation cannot be reproduced by GNU grep',
    };
  }

  return { ere: out };
}
