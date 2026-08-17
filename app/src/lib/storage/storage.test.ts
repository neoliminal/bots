import { createLocalStorage, createMemoryStorage } from "./storage";

describe("createLocalStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("roundtrips JSON values", async () => {
    const storage = createLocalStorage("test.");
    await storage.set("key", { a: 1, b: ["x"] });
    expect(await storage.get("key")).toEqual({ a: 1, b: ["x"] });
  });

  it("returns null for missing keys", async () => {
    const storage = createLocalStorage("test.");
    expect(await storage.get("nope")).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    localStorage.setItem("test.bad", "{not json");
    const storage = createLocalStorage("test.");
    expect(await storage.get("bad")).toBeNull();
  });

  it("namespaces keys with the prefix", async () => {
    const storage = createLocalStorage("test.");
    await storage.set("key", 1);
    expect(localStorage.getItem("test.key")).toBe("1");
  });

  it("removes keys", async () => {
    const storage = createLocalStorage("test.");
    await storage.set("key", 1);
    await storage.remove("key");
    expect(await storage.get("key")).toBeNull();
  });
});

describe("createMemoryStorage", () => {
  it("roundtrips values and isolates instances", async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    await a.set("k", [1, 2]);
    expect(await a.get("k")).toEqual([1, 2]);
    expect(await b.get("k")).toBeNull();
    await a.remove("k");
    expect(await a.get("k")).toBeNull();
  });
});
