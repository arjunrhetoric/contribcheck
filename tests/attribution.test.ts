import { describe, it, expect } from "vitest";
import { attribute, isBotAddress, parseCoAuthors, parseNoreplyLogin, resolveIdentity } from "../src/attribution.js";
import type { RosterMember } from "../src/types.js";

const roster: RosterMember[] = [
  { team: "team-alpha", member_id: "alice", name: "Alice", emails: ["alice@example.com"], github: "alice-gh" },
  { team: "team-alpha", member_id: "bob", name: "Bob", emails: ["bob@example.com", "bob2@example.com"], github: "bob-gh" },
];

describe("attribute: one function decides credit", () => {
  it("co-authored commit splits equally", () => {
    const shares = attribute({
      primaryName: "Alice", primaryEmail: "alice@example.com", primaryLogin: null,
      coAuthors: [{ name: "Bob", email: "bob@example.com", login: null }],
      roster, coAuthorCredit: "equal",
      isSquashContainer: false, squashPrNumber: null, squashDistribution: null,
    });
    expect(shares).toHaveLength(2);
    const total = shares.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 10);
    for (const s of shares) expect(s.share).toBeCloseTo(0.5, 10);
  });

  it("coAuthorCredit none gives full credit to primary", () => {
    const shares = attribute({
      primaryName: "Alice", primaryEmail: "alice@example.com", primaryLogin: null,
      coAuthors: [{ name: "Bob", email: "bob@example.com", login: null }],
      roster, coAuthorCredit: "none",
      isSquashContainer: false, squashPrNumber: null, squashDistribution: null,
    });
    expect(shares).toHaveLength(1);
    expect(shares[0]!.memberId).toBe("alice");
    expect(shares[0]!.share).toBe(1);
  });

  it("unresolved co-author share goes to unattributed", () => {
    const shares = attribute({
      primaryName: "Alice", primaryEmail: "alice@example.com", primaryLogin: null,
      coAuthors: [{ name: "Ghost", email: "ghost@nowhere.test", login: null }],
      roster, coAuthorCredit: "equal",
      isSquashContainer: false, squashPrNumber: null, squashDistribution: null,
    });
    const total = shares.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(shares.some((s) => s.memberId === null)).toBe(true);
  });

  it("squash container with distribution splits churn proportionally", () => {
    const shares = attribute({
      primaryName: "Alice", primaryEmail: "alice@example.com", primaryLogin: null,
      coAuthors: [], roster, coAuthorCredit: "equal",
      isSquashContainer: true, squashPrNumber: 7,
      squashDistribution: [
        { memberId: "alice", commits: 1, churn: 90 },
        { memberId: "bob", commits: 2, churn: 10 },
      ],
    });
    const a = shares.find((s) => s.memberId === "alice")!;
    const b = shares.find((s) => s.memberId === "bob")!;
    expect(a.share).toBeCloseTo(0.9, 10);
    expect(b.share).toBeCloseTo(0.1, 10);
    expect(a.method).toBe("squash-github");
  });

  it("squash fallback credits listed author", () => {
    const shares = attribute({
      primaryName: "Alice", primaryEmail: "alice@example.com", primaryLogin: null,
      coAuthors: [], roster, coAuthorCredit: "equal",
      isSquashContainer: true, squashPrNumber: 7, squashDistribution: null,
    });
    expect(shares).toHaveLength(1);
    expect(shares[0]!.method).toBe("squash-fallback");
  });
});

describe("co-author parsing", () => {
  it("matches key case-insensitively, multiple trailers, name-only", () => {
    const body = "work\n\nCO-AUTHORED-BY: Bob <bob@example.com>\nCo-Authored-By: Solo Name";
    const out = parseCoAuthors(body);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: "Bob", email: "bob@example.com" });
    expect(out[1]).toEqual({ name: "Solo Name", email: "" });
  });
});

describe("identity resolution", () => {
  it("roster email case-insensitive", () => {
    expect(resolveIdentity("x", "ALICE@EXAMPLE.COM", roster, null).memberId).toBe("alice");
  });
  it("github noreply matches roster github", () => {
    expect(resolveIdentity("x", "123+bob-gh@users.noreply.github.com", roster, null).memberId).toBe("bob");
    expect(resolveIdentity("x", "alice-gh@users.noreply.github.com", roster, null).memberId).toBe("alice");
  });
  it("api login matches roster github", () => {
    expect(resolveIdentity("Someone", "other@test.com", roster, "bob-gh").memberId).toBe("bob");
  });
  it("unresolved otherwise", () => {
    expect(resolveIdentity("Ghost", "ghost@nowhere.test", roster, null).memberId).toBeNull();
  });
  it("noreply login parse", () => {
    expect(parseNoreplyLogin("49699333+dependabot[bot]@users.noreply.github.com")).toBe("dependabot");
  });
});

describe("bots", () => {
  it("detects [bot] login, noreply pattern, builtin names, extras", () => {
    expect(isBotAddress("x", "49699333+dependabot[bot]@users.noreply.github.com", null, [])).toBe(true);
    expect(isBotAddress("x", "a@b.com", "sometool[bot]", [])).toBe(true);
    expect(isBotAddress("dependabot", "d@d.com", null, [])).toBe(true);
    expect(isBotAddress("CI Bot", "ci@x.com", null, ["ci bot"])).toBe(true);
    expect(isBotAddress("Alice", "alice@example.com", "alice-gh", [])).toBe(false);
  });
});
