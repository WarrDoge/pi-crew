/**
 * Chain/Parallel DSL Parser — parses workflow chain expressions.
 *
 * Syntax:
 *   step1 -> step2 -> parallel(step3, step4) -> step5
 *   step1:3 -> step2 --with-context -> step3
 *   parallel(a, b, parallel(c, d)) -> e
 *
 * Pattern origin: pi-prompt-template-model chain-parser.ts
 */

export interface ChainStep {
	/** Step name (maps to agent or workflow step ID) */
	name: string;
	/** Nested parallel group */
	parallel?: ChainStep[];
	/** Loop count (default: 1) */
	loopCount?: number;
	/** Pass predecessor output as context */
	withContext?: boolean;
	/** Positional arguments */
	args?: string[];
}

/**
 * Parse a chain DSL string into an AST.
 *
 * @throws {Error} on syntax errors (unclosed parens, empty names, etc.)
 */
export function parseChainDSL(input: string): ChainStep[] {
	const tokens = tokenize(input);
	const parser = new ChainParser(tokens);
	return parser.parse();
}

// ── Tokenizer ────────────────────────────────────────────────────────────

type TokenType = "NAME" | "ARROW" | "LPAREN" | "RPAREN" | "COMMA" | "COLON" | "NUMBER" | "FLAG" | "QUOTED";

interface Token {
	type: TokenType;
	value: string;
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length) {
		// Skip whitespace
		if (/\s/.test(input[i]!)) {
			i++;
			continue;
		}

		// Arrow ->
		if (input[i] === "-" && input[i + 1] === ">") {
			tokens.push({ type: "ARROW", value: "->" });
			i += 2;
			continue;
		}

		// Punctuation
		if (input[i] === "(") {
			tokens.push({ type: "LPAREN", value: "(" });
			i++;
			continue;
		}
		if (input[i] === ")") {
			tokens.push({ type: "RPAREN", value: ")" });
			i++;
			continue;
		}
		if (input[i] === ",") {
			tokens.push({ type: "COMMA", value: "," });
			i++;
			continue;
		}
		if (input[i] === ":") {
			tokens.push({ type: "COLON", value: ":" });
			i++;
			continue;
		}

		// Quoted argument
		if (input[i] === '"' || input[i] === "'") {
			const quote = input[i];
			let str = "";
			i++; // skip opening quote
			while (i < input.length && input[i] !== quote) {
				if (input[i] === "\\" && i + 1 < input.length) {
					i++;
					str += input[i];
				} else {
					str += input[i]!;
				}
				i++;
			}
			if (i >= input.length) throw new Error("Unclosed quoted string in chain DSL");
			i++; // skip closing quote
			tokens.push({ type: "QUOTED", value: str });
			continue;
		}

		// Flag --with-context
		if (input[i] === "-" && input[i + 1] === "-") {
			let flag = "";
			i += 2;
			while (i < input.length && /[a-zA-Z0-9_-]/.test(input[i]!)) {
				flag += input[i];
				i++;
			}
			tokens.push({ type: "FLAG", value: flag });
			continue;
		}

		// Number
		if (/[0-9]/.test(input[i]!)) {
			let num = "";
			while (i < input.length && /[0-9]/.test(input[i]!)) {
				num += input[i];
				i++;
			}
			tokens.push({ type: "NUMBER", value: num });
			continue;
		}

		// Name (a leading '@' is part of a @team reference — R14-C1: without this
		// the tokenizer threw on '@', the whole DSL parse fell back to the simple
		// splitter, and parallel(@a, @b) silently degraded into garbage steps.)
		if (/[a-zA-Z_]/.test(input[i]!) || (input[i] === "@" && /[a-zA-Z_]/.test(input[i + 1] ?? ""))) {
			let name = "";
			while (i < input.length && /[a-zA-Z0-9_.@-]/.test(input[i]!)) {
				name += input[i];
				i++;
			}
			tokens.push({ type: "NAME", value: name });
			continue;
		}

		throw new Error(`Unexpected character '${input[i]}' at position ${i} in chain DSL`);
	}

	return tokens;
}

// ── Recursive Descent Parser ─────────────────────────────────────────────

class ChainParser {
	private pos = 0;

	private tokens: Token[];

	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	parse(): ChainStep[] {
		const steps: ChainStep[] = [];
		steps.push(this.parseStep(0));
		while (this.peek("ARROW")) {
			this.consume("ARROW");
			steps.push(this.parseStep(0));
		}
		if (this.pos < this.tokens.length) {
			throw new Error(`Unexpected token '${this.tokens[this.pos]?.value}' at position ${this.pos}`);
		}
		return steps;
	}

	private parseStep(depth: number = 0): ChainStep {
		// Round 22 (BUG 2): guard against stack overflow on deeply nested input.
		// Without this, a crafted 'parallel(parallel(parallel(...)))' input would
		// recurse unbounded and crash the process with RangeError. Each nesting
		// level needs >=9 chars, so ~130KB could overflow V8's ~15K-frame stack.
		const MAX_CHAIN_NESTING = 100;
		if (depth > MAX_CHAIN_NESTING) {
			throw new Error(`Chain DSL nesting too deep (max ${MAX_CHAIN_NESTING}); likely unbalanced or malicious input`);
		}
		// Check for parallel(...) construct
		if (this.peek("NAME", "parallel")) {
			this.consume("NAME"); // eat "parallel"
			this.consume("LPAREN");
			const parallel: ChainStep[] = [];
			parallel.push(this.parseStep(depth + 1));
			while (this.peek("COMMA")) {
				this.consume("COMMA");
				parallel.push(this.parseStep(depth + 1));
			}
			this.consume("RPAREN");
			const step: ChainStep = { name: "parallel", parallel };
			this.parseModifiers(step);
			return step;
		}

		// Normal step name
		const name = this.consume("NAME").value;
		const step: ChainStep = { name };

		// Parse modifiers
		this.parseModifiers(step);
		return step;
	}

	private parseModifiers(step: ChainStep): void {
		while (this.pos < this.tokens.length) {
			if (this.peek("COLON")) {
				this.consume("COLON");
				const num = this.consume("NUMBER");
				step.loopCount = Number.parseInt(num.value, 10);
			} else if (this.peek("FLAG", "with-context")) {
				this.consume("FLAG");
				step.withContext = true;
			} else if (this.peek("QUOTED")) {
				const arg = this.consume("QUOTED");
				step.args = step.args ?? [];
				step.args.push(arg.value);
			} else {
				break;
			}
		}
	}

	private peek(type: TokenType, value?: string): boolean {
		const tok = this.tokens[this.pos];
		if (!tok) return false;
		if (tok.type !== type) return false;
		if (value !== undefined && tok.value !== value) return false;
		return true;
	}

	private consume(type: TokenType): Token {
		const tok = this.tokens[this.pos];
		if (!tok) throw new Error(`Expected ${type} but reached end of chain DSL`);
		if (tok.type !== type) throw new Error(`Expected ${type} but got ${tok.type}('${tok.value}')`);
		this.pos++;
		return tok;
	}
}
