import { describe, expect, it } from "vitest";
import { mathPlaceholderText } from "@engine/viewport";

describe("mathPlaceholderText", () => {
  it("wraps inline and block tex so unreadied math stays readable", () => {
    expect(mathPlaceholderText("a+b", false)).toBe("$a+b$");
    expect(mathPlaceholderText("x^2", true)).toBe("$$x^2$$");
  });
});
