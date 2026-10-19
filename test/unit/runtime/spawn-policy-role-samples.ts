/**
 * Role samples shared by the R43-S1 transitive-containment tests — kept in a
 * helper so the test file stays declarative and the samples have ONE home.
 * Mirrors role-permission.ts's READ_ONLY_ROLES/WRITE_ROLES classifications.
 */
export const READ_ONLY_ROLE_SAMPLE = ["explorer", "reviewer", "security-reviewer", "analyst", "critic", "planner"] as const;

export const WRITE_ROLE_SAMPLE = ["executor", "test-engineer", "writer", "verifier", "agent", "cold-verifier", "worker"] as const;
