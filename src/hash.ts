export async function sha1Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
