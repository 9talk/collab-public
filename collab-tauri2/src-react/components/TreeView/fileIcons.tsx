import type { Icon } from '@phosphor-icons/react';
import {
	FileText,
	FileTs,
	FileTsx,
	FileJs,
	FileJsx,
	FilePy,
	FileRs,
	FileC,
	FileCpp,
	FileCSharp,
	FileVue,
	FileHtml,
	FileCss,
	FileSvg,
	FileSql,
	FileIni,
	FileImage,
	FileJpg,
	FilePng,
	FileAudio,
	FileVideo,
	FileDoc,
	FilePdf,
	FileCsv,
	FileXls,
	FileZip,
	FileArchive,
	FileCode,
	FileMd,
} from '@phosphor-icons/react';

interface FileIconDef {
	icon: Icon;
	color: string;
}

const EXT_MAP: Record<string, FileIconDef> = {
	// TypeScript
	'.ts': { icon: FileTs, color: '#5c9bcf' },
	'.tsx': { icon: FileTsx, color: '#5c9bcf' },
	'.mts': { icon: FileTs, color: '#5c9bcf' },
	'.cts': { icon: FileTs, color: '#5c9bcf' },

	// JavaScript
	'.js': { icon: FileJs, color: '#c8a35a' },
	'.jsx': { icon: FileJsx, color: '#c8a35a' },
	'.mjs': { icon: FileJs, color: '#c8a35a' },
	'.cjs': { icon: FileJs, color: '#c8a35a' },

	// Python
	'.py': { icon: FilePy, color: '#7aab6e' },

	// Rust
	'.rs': { icon: FileRs, color: '#c07a53' },

	// C family
	'.c': { icon: FileC, color: '#7a8aab' },
	'.h': { icon: FileC, color: '#7a8aab' },
	'.cpp': { icon: FileCpp, color: '#7a8aab' },
	'.hpp': { icon: FileCpp, color: '#7a8aab' },
	'.cc': { icon: FileCpp, color: '#7a8aab' },
	'.cs': { icon: FileCSharp, color: '#8a7aab' },

	// Web
	'.html': { icon: FileHtml, color: '#c07a6e' },
	'.htm': { icon: FileHtml, color: '#c07a6e' },
	'.css': { icon: FileCss, color: '#8a7aab' },
	'.scss': { icon: FileCss, color: '#9a6e8a' },
	'.less': { icon: FileCss, color: '#9a6e8a' },
	'.vue': { icon: FileVue, color: '#7aab7a' },
	'.svelte': { icon: FileCode, color: '#c07a53' },
	'.svg': { icon: FileSvg, color: '#c8a35a' },

	// Data / config
	'.json': { icon: FileCode, color: '#8a8a7a' },
	'.yaml': { icon: FileIni, color: '#8a8a7a' },
	'.yml': { icon: FileIni, color: '#8a8a7a' },
	'.toml': { icon: FileIni, color: '#8a8a7a' },
	'.ini': { icon: FileIni, color: '#8a8a7a' },
	'.env': { icon: FileIni, color: '#8a8a7a' },
	'.sql': { icon: FileSql, color: '#7a8aab' },
	'.csv': { icon: FileCsv, color: '#7aab6e' },
	'.xml': { icon: FileCode, color: '#c07a6e' },

	// Images
	'.png': { icon: FilePng, color: '#8a7aab' },
	'.jpg': { icon: FileJpg, color: '#8a7aab' },
	'.jpeg': { icon: FileJpg, color: '#8a7aab' },
	'.gif': { icon: FileImage, color: '#8a7aab' },
	'.webp': { icon: FileImage, color: '#8a7aab' },
	'.ico': { icon: FileImage, color: '#8a7aab' },

	// Audio / video
	'.mp3': { icon: FileAudio, color: '#c07a6e' },
	'.wav': { icon: FileAudio, color: '#c07a6e' },
	'.ogg': { icon: FileAudio, color: '#c07a6e' },
	'.mp4': { icon: FileVideo, color: '#c07a6e' },
	'.webm': { icon: FileVideo, color: '#c07a6e' },
	'.mov': { icon: FileVideo, color: '#c07a6e' },

	// Documents
	'.pdf': { icon: FilePdf, color: '#c07a6e' },
	'.doc': { icon: FileDoc, color: '#5c9bcf' },
	'.docx': { icon: FileDoc, color: '#5c9bcf' },
	'.xls': { icon: FileXls, color: '#7aab6e' },
	'.xlsx': { icon: FileXls, color: '#7aab6e' },

	// Archives
	'.zip': { icon: FileZip, color: '#8a8a7a' },
	'.tar': { icon: FileArchive, color: '#8a8a7a' },
	'.gz': { icon: FileArchive, color: '#8a8a7a' },
	'.7z': { icon: FileArchive, color: '#8a8a7a' },

	// Markdown — keep as generic note icon
	'.md': { icon: FileText, color: 'var(--item-type-note)' },
	'.mdx': { icon: FileMd, color: '#5c9bcf' },

	// Shell
	'.sh': { icon: FileCode, color: '#7aab6e' },
	'.bash': { icon: FileCode, color: '#7aab6e' },
	'.zsh': { icon: FileCode, color: '#7aab6e' },
	'.fish': { icon: FileCode, color: '#7aab6e' },

	// Go
	'.go': { icon: FileCode, color: '#5c9bcf' },

	// Java / Kotlin
	'.java': { icon: FileCode, color: '#c07a53' },
	'.kt': { icon: FileCode, color: '#8a7aab' },

	// Ruby
	'.rb': { icon: FileCode, color: '#c07a6e' },

	// Swift
	'.swift': { icon: FileCode, color: '#c07a53' },
};

const FILENAME_MAP: Record<string, FileIconDef> = {
	'Dockerfile': { icon: FileCode, color: '#5c9bcf' },
	'Makefile': { icon: FileCode, color: '#8a8a7a' },
	'LICENSE': { icon: FileText, color: '#8a8a7a' },
};

const DEFAULT_ICON: FileIconDef = {
	icon: FileText,
	color: 'var(--item-type-note)',
};

export function getFileIcon(filename: string): FileIconDef {
	const match = FILENAME_MAP[filename];
	if (match) return match;

	const dotIdx = filename.lastIndexOf('.');
	if (dotIdx >= 0) {
		const ext = filename.slice(dotIdx).toLowerCase();
		const extMatch = EXT_MAP[ext];
		if (extMatch) return extMatch;
	}

	return DEFAULT_ICON;
}
