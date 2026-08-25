import { describe, expect, it } from "vitest";
import { EnvironmentError, parseServerEnv } from "@/lib/env";

const valid = {
  TRUEFORGE_BASE_URL: "http://localhost:3010",
  TRUEFORGE_API_TOKEN: "tf_secret_value",
};

describe("parseServerEnv", () => {
  it("returns the parsed environment when every variable is valid", () => {
    expect(parseServerEnv(valid)).toEqual(valid);
  });

  it("treats an empty token the same as an unset one", () => {
    expect(parseServerEnv({ ...valid, TRUEFORGE_API_TOKEN: "" })).toEqual({
      TRUEFORGE_BASE_URL: valid.TRUEFORGE_BASE_URL,
      TRUEFORGE_API_TOKEN: undefined,
    });
  });

  it("names the missing variable instead of starting with an unusable value", () => {
    expect(() => parseServerEnv({})).toThrow(/TRUEFORGE_BASE_URL/);
  });

  it("rejects a base URL that is not a URL", () => {
    expect(() => parseServerEnv({ ...valid, TRUEFORGE_BASE_URL: "localhost:3010" })).toThrow(
      EnvironmentError,
    );
  });

  it("never puts a credential value in the error it throws", () => {
    try {
      parseServerEnv({ TRUEFORGE_API_TOKEN: "tf_secret_value" });
      expect.unreachable("expected an EnvironmentError");
    } catch (error) {
      expect(String(error)).not.toContain("tf_secret_value");
    }
  });
});
