import { toast } from 'svelte-sonner';

export function toastError(message: string) {
	toast.error(message, { duration: 6000 });
}

export function toastWarning(message: string) {
	toast.warning(message, { duration: 5000 });
}

export function toastSuccess(message: string) {
	toast.success(message, { duration: 4000 });
}

export function toastInfo(message: string) {
	toast.info(message, { duration: 4000 });
}
