import type { GreenLevel, VerificationContract, VerificationEvidence } from "../../state/types.ts";

const GREEN_ORDER: Record<GreenLevel, number> = {
	none: 0,
	targeted: 1,
	package: 2,
	workspace: 3,
	merge_ready: 4,
};

export interface GreenContractOutcome {
	requiredGreenLevel: GreenLevel;
	observedGreenLevel: GreenLevel;
	satisfied: boolean;
}

export function greenLevelSatisfies(observed: GreenLevel, required: GreenLevel): boolean {
	return GREEN_ORDER[observed] >= GREEN_ORDER[required];
}

export function evaluateGreenContract(contract: VerificationContract, evidence?: VerificationEvidence): GreenContractOutcome {
	const observedGreenLevel = evidence?.observedGreenLevel ?? "none";
	return {
		requiredGreenLevel: contract.requiredGreenLevel,
		observedGreenLevel,
		satisfied: greenLevelSatisfies(observedGreenLevel, contract.requiredGreenLevel),
	};
}

export function inferGreenLevelFromTask(success: boolean, contract: VerificationContract): GreenLevel {
	if (!success) return "none";
	if (contract.requiredGreenLevel === "none") return "none";
	return contract.allowManualEvidence ? contract.requiredGreenLevel : "targeted";
}

/** R4-5 (DR-02 wave 2): true when the contract REQUIRES a green level but
 *  configures zero verification commands — the default contract shape for
 *  every `verify: true` step (task-packet defaultVerificationContract).
 *  With no commands to run, satisfaction can only ever come from
 *  self-attestation (allowManualEvidence → inferGreenLevelFromTask returns
 *  the required level), which silently reports e.g. "targeted/targeted".
 *  Surface that as `decorative: true` on the evidence instead of changing
 *  the satisfied logic or the defaults (detection-first, no behavior flip). */
export function isDecorativeVerification(contract: VerificationContract): boolean {
	return contract.requiredGreenLevel !== "none" && contract.commands.length === 0;
}

export function createVerificationEvidence(contract: VerificationContract, success: boolean, notes: string): VerificationEvidence {
	const observedGreenLevel = inferGreenLevelFromTask(success, contract);
	const outcome = evaluateGreenContract(contract, {
		requiredGreenLevel: contract.requiredGreenLevel,
		observedGreenLevel,
		satisfied: false,
		commands: [],
		notes,
	});
	// R4-5: stamp the decorative flag so consumers (post-execution evidence
	// builder, policy engine, UI) can tell self-attested satisfaction from
	// command-backed satisfaction. Satisfied logic is untouched.
	const decorative = isDecorativeVerification(contract);
	return {
		requiredGreenLevel: contract.requiredGreenLevel,
		observedGreenLevel,
		satisfied: outcome.satisfied,
		commands: contract.commands.map((cmd) => ({
			cmd,
			status: "not_run" as const,
		})),
		notes,
		...(decorative ? { decorative: true } : {}),
	};
}
