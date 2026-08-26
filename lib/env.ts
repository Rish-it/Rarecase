import { z } from "zod";

/**
 * Environment is untrusted input, so it is parsed rather than read. Credentials
 * for models, GitHub, and the sandbox belong to the TrueForge harness; the
 * only secret this application may hold is the token it uses to reach it.
 */
const serverEnvSchema = z.object({
  // Constrained to http(s): a bare `localhost:3010` parses as a URL whose scheme
  // is `localhost`, and would fail later as a confusing fetch error instead.
  TRUEFORGE_BASE_URL: z.url({ protocol: /^https?$/ }),
  // An unset variable and one written as `KEY=` mean the same thing to a reader,
  // so they must mean the same thing here.
  TRUEFORGE_API_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvironmentError extends Error {
  constructor(problems: string[]) {
    super(`Invalid server environment:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvironmentError";
  }
}

/**
 * Throws on the first invalid environment rather than letting a malformed value
 * reach a tool call. The message names variables only — never their values, so
 * a token cannot leak into a log or a stack trace.
 */
export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  return result.data;
}
