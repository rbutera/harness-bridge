export interface UnrestrictedSandboxPolicy {
  type: "dangerFullAccess";
}

export function unrestrictedSandboxPolicy(): UnrestrictedSandboxPolicy {
  return { type: "dangerFullAccess" };
}
