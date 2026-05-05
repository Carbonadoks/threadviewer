import { writable } from 'svelte/store';

export const lightboxSrc = writable<string | null>(null);

export function openLightbox(src: string) {
	lightboxSrc.set(src);
}

export function closeLightbox() {
	lightboxSrc.set(null);
}
