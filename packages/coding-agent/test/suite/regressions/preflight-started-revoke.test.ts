import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

// Tron: a host revokes an accepted prompt by throwing from preflightResult("started"),
// for example when Stop arrived while the run was being prepared. The revoked
// prompt must not start or be appended, and the session must return to idle so
// a waiting abort() settles.
describe("preflightResult('started') revocation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("ends the start without a run when the host throws", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			() => {
				throw new Error("a revoked prompt must never reach the provider");
			},
			fauxAssistantMessage("later answer"),
		]);
		const revoked = new Error("revoked before agent admission");
		await expect(
			harness.session.prompt("REVOKED", {
				preflightResult: (disposition) => {
					if (disposition === "started") throw revoked;
				},
			}),
		).rejects.toBe(revoked);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		await harness.session.abort();
		expect(getUserTexts(harness)).not.toContain("REVOKED");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);

		harness.setResponses([fauxAssistantMessage("later answer")]);
		await harness.session.prompt("LATER");
		expect(getUserTexts(harness)).toEqual(["LATER"]);
	});
});
