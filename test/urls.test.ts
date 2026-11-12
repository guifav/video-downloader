import { describe, expect, it } from "vitest";
import { parseVideoUrl } from "../src/urls";

const ok = (input: string) => {
	const r = parseVideoUrl(input);
	if (!r.ok) throw new Error(`esperava ok para ${input}: ${r.error}`);
	return r;
};

describe("parseVideoUrl: YouTube", () => {
	it.each([
		["https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
		["https://youtube.com/watch?v=jNQXAC9IVRw&t=10s", "jNQXAC9IVRw"],
		["https://m.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
		["https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL123&index=2", "jNQXAC9IVRw"],
		["https://youtu.be/jNQXAC9IVRw?si=abc", "jNQXAC9IVRw"],
		["https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw"],
		["https://www.youtube.com/live/jNQXAC9IVRw", "jNQXAC9IVRw"],
		["https://www.youtube.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
		["youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
		["  https://www.youtube.com/watch?v=jNQXAC9IVRw  ", "jNQXAC9IVRw"],
	])("aceita %s", (input, id) => {
		const r = ok(input);
		expect(r.platform).toBe("youtube");
		expect(r.videoId).toBe(id);
		expect(r.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${id}`);
	});

	it.each([
		["https://www.youtube.com/playlist?list=PL123", /Playlists/],
		["https://www.youtube.com/@YouTube", /video avulso/],
		["https://www.youtube.com/watch?v=short", /invalido/],
		["https://www.youtube.com/watch", /invalido/],
		["https://youtu.be/", /invalido/],
		["https://www.youtube.com/watch?v=jNQXAC9IVRwX", /invalido/],
		["https://www.youtube.com/watch?v=jNQXAC9IV%20w", /invalido/],
	])("rejeita %s", (input, message) => {
		const r = parseVideoUrl(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(message);
	});
});

describe("parseVideoUrl: X", () => {
	it.each([
		["https://x.com/NASA/status/1856402424813256962", "https://x.com/NASA/status/1856402424813256962", "1856402424813256962"],
		["https://twitter.com/oshtru/status/1577855540407197696?s=20", "https://x.com/oshtru/status/1577855540407197696", "1577855540407197696"],
		["https://mobile.twitter.com/a_b/status/1/", "https://x.com/a_b/status/1", "1"],
		["https://x.com/i/status/123", "https://x.com/i/status/123", "123"],
		["https://x.com/u/status/123/video/2", "https://x.com/u/status/123/video/2", "123-2"],
	])("aceita %s", (input, canonical, id) => {
		const r = ok(input);
		expect(r.platform).toBe("x");
		expect(r.canonicalUrl).toBe(canonical);
		expect(r.videoId).toBe(id);
	});

	it.each([
		"https://x.com/NASA",
		"https://x.com/NASA/status/abc",
		"https://x.com/NASA/status/1/photo/1",
		"https://x.com/NASA/status/1/video/9",
		"https://x.com/home",
	])("rejeita %s", (input) => {
		expect(parseVideoUrl(input).ok).toBe(false);
	});
});

describe("parseVideoUrl: Instagram", () => {
	it.each([
		["https://www.instagram.com/reel/CDUMkliABpa/", "https://www.instagram.com/reel/CDUMkliABpa/", "CDUMkliABpa"],
		["https://instagram.com/reels/Cop84x6u7CP/?igsh=abc123", "https://www.instagram.com/reel/Cop84x6u7CP/", "Cop84x6u7CP"],
		["https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=2", "https://www.instagram.com/p/BQ0eAlwhDrw/", "BQ0eAlwhDrw"],
		["https://www.instagram.com/tv/CDUMkliABpa", "https://www.instagram.com/tv/CDUMkliABpa/", "CDUMkliABpa"],
		["https://m.instagram.com/natgeo/reel/DBpN4xYxQYQ/", "https://www.instagram.com/reel/DBpN4xYxQYQ/", "DBpN4xYxQYQ"],
		["instagram.com/user.name_1/p/BQ0eAlwhDrw", "https://www.instagram.com/p/BQ0eAlwhDrw/", "BQ0eAlwhDrw"],
	])("aceita %s", (input, canonical, id) => {
		const r = ok(input);
		expect(r.platform).toBe("instagram");
		expect(r.canonicalUrl).toBe(canonical);
		expect(r.videoId).toBe(id);
	});

	it.each([
		["https://www.instagram.com/natgeo/", /post, reel/],
		["https://www.instagram.com/stories/natgeo/3456/", /Stories/],
		["https://www.instagram.com/explore/tags/cats/", /post, reel/],
		["https://www.instagram.com/p/abc/", /post, reel/],
		["https://www.instagram.com/p/BQ0eAlwhDrw/extra/", /post, reel/],
		["https://www.instagram.com/share/reel/BAy9bT6kXv/", /compartilhamento/],
	])("rejeita %s", (input, message) => {
		const r = parseVideoUrl(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(message);
	});
});

describe("parseVideoUrl: Facebook", () => {
	it.each([
		["https://www.facebook.com/watch/?v=10155529876156509", "https://www.facebook.com/watch/?v=10155529876156509", "10155529876156509"],
		["https://facebook.com/watch?v=10155529876156509&ref=sharing", "https://www.facebook.com/watch/?v=10155529876156509", "10155529876156509"],
		["https://m.facebook.com/video.php?v=123456", "https://www.facebook.com/watch/?v=123456", "123456"],
		["https://www.facebook.com/cnn/videos/10155529876156509/", "https://www.facebook.com/watch/?v=10155529876156509", "10155529876156509"],
		["https://web.facebook.com/natgeo/videos/some-slug/1234567890/?mibextid=x", "https://www.facebook.com/watch/?v=1234567890", "1234567890"],
		["https://www.facebook.com/reel/1195289147628387", "https://www.facebook.com/reel/1195289147628387", "1195289147628387"],
		["https://www.facebook.com/reel/1847596256576506/?mibextid=wwXIfr&rdid=Qx&share_url=x", "https://www.facebook.com/reel/1847596256576506", "1847596256576506"],
	])("aceita %s", (input, canonical, id) => {
		const r = ok(input);
		expect(r.platform).toBe("facebook");
		expect(r.canonicalUrl).toBe(canonical);
		expect(r.videoId).toBe(id);
	});

	it.each([
		["https://fb.watch/HDY9vXQxX6/", /Compartilhar > Copiar link/],
		["https://www.facebook.com/share/v/19giuAapf3/", /compartilhamento/],
		["https://www.facebook.com/natgeo", /video ou reel/],
		["https://www.facebook.com/watch/?v=abc", /video ou reel/],
		["https://www.facebook.com/reel/abc", /video ou reel/],
		["https://www.facebook.com/watch/live/?v=123456", /video ou reel/],
		["https://www.facebook.com/pepsi/posts/1054998311204476", /video ou reel/],
		["https://www.facebook.com/groups/1024490957622648/permalink/1396382447100162/", /video ou reel/],
		["https://www.facebook.com/permalink.php?story_fbid=1&id=2", /video ou reel/],
		["https://www.facebook.com/stories/123/", /Stories/],
		["https://www.facebook.com/profile.php?id=4", /video ou reel/],
		["https://www.facebook.com/photo/?fbid=1", /video ou reel/],
		["https://www.facebook.com/cnn/videos/abc/", /video ou reel/],
		["https://www.facebook.com/cnn/videos/a/b/c/123/", /video ou reel/],
	])("rejeita %s", (input, message) => {
		const r = parseVideoUrl(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(message);
	});
});

describe("parseVideoUrl: entradas hostis ou fora de escopo", () => {
	it.each([
		"",
		"   ",
		"nao e url",
		"https://vimeo.com/123",
		"https://www.youtube.com.evil.com/watch?v=jNQXAC9IVRw",
		"https://evil.com/?u=https://www.youtube.com/watch?v=jNQXAC9IVRw",
		"https://www.instagram.com.evil.com/reel/CDUMkliABpa/",
		"https://user:pass@www.instagram.com/reel/CDUMkliABpa/",
		"https://facebook.com.evil.com/reel/1195289147628387",
		"https://evilfacebook.com/reel/1195289147628387",
		"https://user:pass@www.facebook.com/reel/1195289147628387",
		"https://www.facebook.com:8443/reel/1195289147628387",
		"https://user:pass@www.youtube.com/watch?v=jNQXAC9IVRw",
		"https://www.youtube.com:8443/watch?v=jNQXAC9IVRw",
		"ftp://www.youtube.com/watch?v=jNQXAC9IVRw",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"http://169.254.169.254/latest/meta-data",
		`https://www.youtube.com/watch?v=jNQXAC9IVRw&x=${"a".repeat(3000)}`,
	])("rejeita %s", (input) => {
		expect(parseVideoUrl(input).ok).toBe(false);
	});

	it("rejeita tipos que nao sao string", () => {
		for (const value of [undefined, null, 42, {}, ["https://youtu.be/jNQXAC9IVRw"]]) {
			expect(parseVideoUrl(value).ok).toBe(false);
		}
	});
});

describe("parseVideoUrl: TikTok", () => {
	it.each([
		["https://www.tiktok.com/@avery_arnett2/video/7682913384781696269", "https://www.tiktok.com/@avery_arnett2/video/7682913384781696269"],
		["https://www.tiktok.com/@charlotte.shares/video/7573750062094847263?_r=1&_t=ZS-9ANqHlv6OCD", "https://www.tiktok.com/@charlotte.shares/video/7573750062094847263"],
		["tiktok.com/@a_b-c/video/7682913384781696269/", "https://www.tiktok.com/@a_b-c/video/7682913384781696269"],
		["https://m.tiktok.com/@x/video/7682913384781696269", "https://www.tiktok.com/@x/video/7682913384781696269"],
		["https://www.tiktok.com/@/video/7667617140471598356?_r=1", "https://www.tiktok.com/@/video/7667617140471598356"],
	])("aceita %s", (input, canonical) => {
		const r = ok(input);
		expect(r.platform).toBe("tiktok");
		expect(r.canonicalUrl).toBe(canonical);
		expect(r.videoId).toBe(canonical.split("/").pop());
	});

	it.each([
		["https://www.tiktok.com/@avery_arnett2", /precisa apontar para um video/],
		["https://www.tiktok.com/@avery_arnett2/photo/7682913384781696269", /Fotos/],
		["https://www.tiktok.com/@avery_arnett2/live", /lives/],
		["https://www.tiktok.com/music/som-7682913384781696269", /precisa apontar para um video/],
		["https://www.tiktok.com/@a/video/abc", /precisa apontar para um video/],
		["https://vm.tiktok.com/ZSbpfF4Dp/", /resolvido antes/],
		["https://www.tiktok.com/t/ZTRC5xgJp/", /resolvido antes/],
		["https://www.tiktok.com.evil.com/@a/video/7682913384781696269", /nao suportada/],
	])("rejeita %s", (input, message) => {
		const r = parseVideoUrl(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(message);
	});
});
