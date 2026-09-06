export function ancestorDirs(path: string): string[] {
	const parts = path.split("/").filter(Boolean);
	parts.pop(); // drop the file name itself
	const dirs: string[] = [];
	let acc = "";
	for (const part of parts) {
		acc = acc ? `${acc}/${part}` : part;
		dirs.push(acc);
	}
	return dirs;
}

export function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export function conflictCopyPath(path: string, label: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	if (dot > slash) {
		return `${path.slice(0, dot)} (${label})${path.slice(dot)}`;
	}
	return `${path} (${label})`;
}
