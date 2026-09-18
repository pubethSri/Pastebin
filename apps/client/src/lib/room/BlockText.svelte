<script lang="ts">
  import type { RichToken } from "../highlight";

  let { tokens }: { tokens: RichToken[] } = $props();
</script>

<!--
  The `{#each}` below is written on one line on purpose. This is a `<pre>`, so
  every space and newline in the template survives into the rendered text —
  indenting the block for readability would silently inject whitespace into
  someone's command. Formatters will want to break this up; don't let them.
  The nesting makes it longer than it was; it does not make it splittable.

  Tokens render through normal text interpolation, never `{@html}`: the content
  is untrusted by definition. This is the reason `highlight.ts` is hand-written
  rather than a library — Prism, highlight.js and Shiki all want to hand back an
  HTML string, and there is no safe way to render one here. `linkify` only ever
  produces http(s) hrefs, so nothing can smuggle in a `javascript:` URL either.

  A `plain` token emits bare text rather than an empty span, so an unhighlighted
  block builds exactly the DOM it always did.
-->
<pre class="block-text px-3 py-2">{#each tokens as token}{#each token.segments as segment}{#if segment.kind === "link"}<a href={segment.href} target="_blank" rel="noopener noreferrer nofollow" class="text-sky-700 underline decoration-sky-700/40 underline-offset-2 hover:decoration-sky-700">{segment.value}</a>{:else if token.kind === "plain"}{segment.value}{:else}<span class="tok-{token.kind}">{segment.value}</span>{/if}{/each}{/each}</pre>
