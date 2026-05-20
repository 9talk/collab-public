import { describe, test, expect } from "bun:test";
import { isImageFile, IMAGE_EXTENSIONS } from "./image";

describe("isImageFile", () => {
  test("recognizes common image extensions", () => {
    expect(isImageFile("photo.png")).toBe(true);
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("photo.jpeg")).toBe(true);
    expect(isImageFile("photo.gif")).toBe(true);
    expect(isImageFile("photo.webp")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isImageFile("photo.PNG")).toBe(true);
    expect(isImageFile("photo.JPG")).toBe(true);
    expect(isImageFile("photo.Jpeg")).toBe(true);
  });

  test("rejects non-image files", () => {
    expect(isImageFile("file.txt")).toBe(false);
    expect(isImageFile("file.md")).toBe(false);
    expect(isImageFile("file.ts")).toBe(false);
    expect(isImageFile("file.pdf")).toBe(false);
  });

  test("rejects files without extension", () => {
    expect(isImageFile("Makefile")).toBe(false);
    expect(isImageFile("README")).toBe(false);
  });

  test("handles paths with directories", () => {
    expect(isImageFile("/path/to/image.png")).toBe(true);
    expect(isImageFile("/path/to/file.txt")).toBe(false);
  });

  test("recognizes modern formats", () => {
    expect(isImageFile("photo.avif")).toBe(true);
    expect(isImageFile("photo.heic")).toBe(true);
    expect(isImageFile("photo.heif")).toBe(true);
  });
});

describe("IMAGE_EXTENSIONS", () => {
  test("is a Set", () => {
    expect(IMAGE_EXTENSIONS).toBeInstanceOf(Set);
  });

  test("contains lowercase dot-prefixed extensions", () => {
    expect(IMAGE_EXTENSIONS.has(".png")).toBe(true);
    expect(IMAGE_EXTENSIONS.has(".jpg")).toBe(true);
    expect(IMAGE_EXTENSIONS.has("png")).toBe(false);
  });
});
