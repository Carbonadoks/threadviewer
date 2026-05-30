import { writable } from 'svelte/store';

export interface LightboxState {
	src: string;
	alt: string;
}

export const lightbox = writable<LightboxState | null>(null);

export function openLightbox(src: string, alt = '') {
	lightbox.set({ src, alt: alt ?? '' });
}

export function closeLightbox() {
	lightbox.set(null);
}
