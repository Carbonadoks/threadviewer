import { writable } from 'svelte/store';

export interface LightboxState {
	src: string;
	alt: string;
	variants?: LightboxImageVariants;
}

export interface LightboxImageVariants {
	originalSrc: string;
	mirrorSrc: string;
	initialView?: 'original' | 'mirror';
}

export const lightbox = writable<LightboxState | null>(null);

export function openLightbox(src: string, alt = '', variants?: LightboxImageVariants) {
	lightbox.set({ src, alt: alt ?? '', variants });
}

export function closeLightbox() {
	lightbox.set(null);
}
