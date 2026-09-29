import { expect, test } from "bun:test";
import { formString } from "./form-data";

test("formString returns text values and ignores file entries", () => {
  const form = new FormData();
  form.set("name", "A page");
  form.set("upload", new File(["content"], "notes.txt", { type: "text/plain" }));

  expect(formString(form, "name")).toBe("A page");
  expect(formString(form, "missing")).toBe("");
  expect(formString(form, "missing", "fallback")).toBe("fallback");
  expect(formString(form, "upload", "not text")).toBe("not text");
});
