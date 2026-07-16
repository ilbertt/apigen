/**
 * Vendored, trimmed copy of `sql-template-tag` (v5).
 *
 * Original: https://github.com/blakeembrey/sql-template-tag
 * Copyright (c) 2016 Blake Embrey (hello@blakeembrey.com) — MIT License.
 * See ./LICENSE for the full license text and ./NOTICE for what we changed.
 *
 * Vendored (not depended on) so the apigen runtime keeps ZERO dependencies.
 * Trimmed to the surface apigen composes with: the `Sql` fragment class, the
 * `sql` tag, `join` (for `in` lists), and `raw`/`empty`. The param-numbering
 * logic is unchanged from upstream — request values only ever reach the database
 * as bound params, never as SQL text.
 */

export type Value = unknown;
export type RawValue = Value | Sql;

export class Sql {
  readonly values: Value[];
  readonly strings: string[];

  constructor({
    rawStrings,
    rawValues,
  }: {
    rawStrings: readonly string[];
    rawValues: readonly RawValue[];
  }) {
    if (rawStrings.length - 1 !== rawValues.length) {
      if (rawStrings.length === 0) {
        throw new TypeError('Expected at least 1 string');
      }
      throw new TypeError(
        `Expected ${rawStrings.length} strings to have ${rawStrings.length - 1} values`,
      );
    }

    const valuesLength = rawValues.reduce<number>(
      // biome-ignore lint/complexity/useMaxParams: Array.prototype.reduce callback signature is fixed.
      (len, value) => len + (value instanceof Sql ? value.values.length : 1),
      0,
    );

    this.values = new Array(valuesLength);
    this.strings = new Array(valuesLength + 1);

    this.strings[0] = rawStrings[0] as string;

    let i = 0;
    let pos = 0;
    while (i < rawValues.length) {
      const child = rawValues[i++];
      const rawString = rawStrings[i] as string;

      if (child instanceof Sql) {
        this.strings[pos] = (this.strings[pos] as string) + (child.strings[0] as string);

        let childIndex = 0;
        while (childIndex < child.values.length) {
          this.values[pos++] = child.values[childIndex++];
          this.strings[pos] = child.strings[childIndex] as string;
        }

        this.strings[pos] = (this.strings[pos] as string) + rawString;
      } else {
        this.values[pos++] = child;
        this.strings[pos] = rawString;
      }
    }
  }

  get text(): string {
    let i = 1;
    let value = this.strings[0] as string;
    while (i < this.strings.length) {
      value += `$${i}${this.strings[i++]}`;
    }
    return value;
  }
}

/** Build a fragment from raw text with no bound params (identifiers, keywords). */
export function raw(value: string): Sql {
  return new Sql({ rawStrings: [value], rawValues: [] });
}

export const empty: Sql = raw('');

/** Join fragments/values with a separator — used for `in (…)` lists. */
export function join({
  values,
  separator = ',',
  prefix = '',
  suffix = '',
}: {
  values: readonly RawValue[];
  separator?: string;
  prefix?: string;
  suffix?: string;
}): Sql {
  if (values.length === 0) {
    throw new TypeError('Expected `join` to be called with a non-empty array');
  }
  return new Sql({
    rawStrings: [prefix, ...Array(values.length - 1).fill(separator), suffix],
    rawValues: values,
  });
}

// biome-ignore lint/complexity/useMaxParams: tagged-template signature is fixed by the language.
export function sql(strings: TemplateStringsArray, ...values: RawValue[]): Sql {
  return new Sql({ rawStrings: strings, rawValues: values });
}
