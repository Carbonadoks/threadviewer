<script lang="ts">
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { getProfiles } from '$lib/api/bluesky';

	let { onselect }: { onselect: (profile: ProfileInfo) => void } = $props();

	let expanded = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let users: Array<ProfileInfo & { cachedPosts: number }> = $state([]);

	async function load() {
		if (loaded || loading) return;
		loading = true;
		try {
			const res = await fetch('/api/cache-index');
			if (!res.ok) return;
			const data: { accounts: Array<{ did: string; postCount: number; reachedEnd: boolean; updatedAt: string }> } = await res.json();
			if (data.accounts.length === 0) return;

			const profiles = await getProfiles(data.accounts.map((a) => a.did));
			const metaByDid = new Map(data.accounts.map((a) => [a.did, a]));

			users = profiles
				.map((p) => ({
					...p,
					cachedPosts: metaByDid.get(p.did)?.postCount ?? 0
				}))
				.sort((a, b) => b.cachedPosts - a.cachedPosts);
		} catch {
			// silently fail
		} finally {
			loading = false;
			loaded = true;
		}
	}

	function toggle() {
		expanded = !expanded;
		if (expanded && !loaded) load();
	}
</script>

<div class="cached-users">
	<button class="toggle-btn" onclick={toggle}>
		{expanded ? '- Hide' : '+ Show'} cached users
	</button>

	{#if expanded}
		{#if loading}
			<p class="loading-text">Loading cached users…</p>
		{:else if users.length > 0}
			<div class="users-grid">
				{#each users as user (user.did)}
					<button class="user-card wobbly-border-light" onclick={() => onselect(user)}>
						{#if user.avatar}
							<img src={user.avatar} alt="" class="user-avatar" />
						{:else}
							<div class="user-avatar placeholder"></div>
						{/if}
						<div class="user-info">
							<span class="user-name">{user.displayName || user.handle}</span>
							<span class="user-handle">@{user.handle}</span>
							<span class="user-cached">{user.cachedPosts.toLocaleString()} posts cached</span>
						</div>
					</button>
				{/each}
			</div>
		{:else if loaded}
			<p class="loading-text">No cached users found.</p>
		{/if}
	{/if}
</div>

<style>
	.cached-users {
		max-width: 600px;
		margin: 0 auto;
	}

	.toggle-btn {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 0.9rem;
		padding: 4px 0;
		font-family: inherit;
		cursor: pointer;
	}

	.toggle-btn:hover {
		color: var(--accent);
	}

	.loading-text {
		color: var(--muted);
		font-size: 0.9rem;
		margin-top: 8px;
	}

	.users-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 8px;
		margin-top: 8px;
	}

	.user-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: var(--card-bg);
		border: none;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		transition: opacity 0.2s;
	}

	.user-card:hover {
		opacity: 0.7;
	}

	.user-avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.user-avatar.placeholder {
		background: var(--muted);
		opacity: 0.3;
	}

	.user-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.user-name {
		font-size: 0.9rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-handle {
		font-size: 0.8rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-cached {
		font-size: 0.75rem;
		color: var(--muted);
		opacity: 0.8;
	}
</style>
