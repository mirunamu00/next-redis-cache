// Legacy handler Buffer <-> base64 serialization: characterization tests pinning 1.0.6 behavior.
import { describe, expect, it } from "vitest";
import { convertStringsToBuffers, parseBuffersToStrings } from "../../src/buffer-utils";

describe("parseBuffersToStrings", () => {
  it("encodes the APP_ROUTE body Buffer as base64", () => {
    const value: Record<string, unknown> = { kind: "APP_ROUTE", body: Buffer.from("hello"), status: 200 };
    parseBuffersToStrings(value);
    expect(value.body).toBe(Buffer.from("hello").toString("base64"));
    expect(value.status).toBe(200);
  });

  it("encodes APP_PAGE rscData and segmentData (Map) as base64", () => {
    const value: Record<string, unknown> = {
      kind: "APP_PAGE",
      html: "<html></html>",
      rscData: Buffer.from("rsc"),
      segmentData: new Map([["/_tree", Buffer.from("tree")]]),
    };
    parseBuffersToStrings(value);
    expect(value.rscData).toBe(Buffer.from("rsc").toString("base64"));
    expect(value.segmentData).toEqual({ "/_tree": Buffer.from("tree").toString("base64") });
    expect(value.html).toBe("<html></html>");
  });

  it("leaves other kinds and empty values untouched", () => {
    const fetchValue = { kind: "FETCH", data: { body: "x" } };
    parseBuffersToStrings(fetchValue);
    expect(fetchValue).toEqual({ kind: "FETCH", data: { body: "x" } });
    expect(() => parseBuffersToStrings(null)).not.toThrow();
    expect(() => parseBuffersToStrings(undefined)).not.toThrow();
  });
});

describe("convertStringsToBuffers", () => {
  it("decodes the APP_ROUTE body string back into a Buffer", () => {
    const value: Record<string, unknown> = { kind: "APP_ROUTE", body: Buffer.from("hi").toString("base64") };
    convertStringsToBuffers(value);
    expect(Buffer.isBuffer(value.body)).toBe(true);
    expect(String(value.body)).toBe("hi");
  });

  it("decodes APP_PAGE rscData and the segmentData object back into Buffer and Map", () => {
    const value: Record<string, unknown> = {
      kind: "APP_PAGE",
      rscData: Buffer.from("rsc").toString("base64"),
      segmentData: { "/_tree": Buffer.from("tree").toString("base64") },
    };
    convertStringsToBuffers(value);
    expect(Buffer.isBuffer(value.rscData)).toBe(true);
    expect(value.segmentData).toBeInstanceOf(Map);
    expect((value.segmentData as Map<string, Buffer>).get("/_tree")?.toString()).toBe("tree");
  });

  it("keeps a segmentData that is already a Map as-is", () => {
    const map = new Map([["/_tree", Buffer.from("t")]]);
    const value = { kind: "APP_PAGE", segmentData: map };
    convertStringsToBuffers(value);
    expect(value.segmentData).toBe(map);
  });
});
