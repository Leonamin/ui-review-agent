import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { alignmentContractSchema, measureFormRowAlignment, measureGroupAlignment } from '../src/group-alignment.js';

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const toolbar = `
<style>
    :root { --large-surface: 2.5rem; --small-surface: 1.875rem; }
    [role="group"] { display: flex; align-items: center; gap: .5rem; overflow-x: auto; }
    button { box-sizing: border-box; flex: none; border-radius: 99rem; color: #111; background: transparent; padding: 0 1em; }
    .outlined { min-height: var(--large-surface); border: thin solid #777; border-radius: 100vw; }
    .surface { isolation: isolate; position: relative; height: 3rem; border: 0; }
    .surface::before {
        box-sizing: border-box; position: absolute; inset-inline: 0; top: 50%; height: var(--small-surface);
        translate: 0 -50%; content: ''; z-index: -1; border-radius: inherit; border: thin solid #777;
        background: white; pointer-events: none;
    }
</style>
<div id="sample" role="group" aria-label="Options">
    <button class="outlined">Category</button>
    <div><button class="surface" aria-haspopup="listbox">Label of a different length</button></div>
    <button class="surface" aria-haspopup="listbox">Period</button>
</div>`;

test('measures a bordered surface and centered pseudo surfaces independently of hit areas and wrapper depth', async () => {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    try {
        await page.setContent(toolbar);
        const inferred = await measureGroupAlignment(page);
        const [candidate] = inferred.checks;
        assert.equal(candidate?.status, 'candidate');
        assert.deepEqual(candidate?.members.map(member => member.visualSource), ['element', 'before', 'before']);
        const [first, second, third] = candidate.members;
        assert.equal(first.hitBox.height, first.visualBox.height);
        assert.ok(second.hitBox.height > first.hitBox.height);
        assert.ok(second.visualBox.height < first.visualBox.height);
        assert.notEqual(second.visualBox.width, third.visualBox.width);
        assert.deepEqual(candidate.differences, [{ kind: 'cross-size', spread: first.visualBox.height - second.visualBox.height }]);

        const explicit = await measureGroupAlignment(page, [{ groupSelector: '#sample', crossSize: 'equal', alignment: 'center' }]);
        assert.equal(explicit.checks.length, 1);
        assert.equal(explicit.checks[0].status, 'violation');
        assert.equal(explicit.checks[0].contractIndex, 1);

        await page.addStyleTag({ content: ':root { font-size: 21px; }' });
        const resized = await measureGroupAlignment(page);
        assert.ok(resized.checks[0].differences[0].spread > candidate.differences[0].spread);
        assert.equal(resized.tolerance, 1 / 2);
    } finally {
        await page.close();
    }
});

test('allows intentional size variants and equal painted heights with different hit areas and label widths', async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(toolbar);
        const mixed = await measureGroupAlignment(page, [{ groupSelector: '#sample', crossSize: 'mixed', alignment: 'center' }]);
        assert.deepEqual(mixed.checks.map(check => check.status), ['passed']);

        await page.addStyleTag({ content: '.outlined { min-height: var(--small-surface); }' });
        const equal = await measureGroupAlignment(page, [{ groupSelector: '#sample', crossSize: 'equal', alignment: 'center' }]);
        assert.deepEqual(equal.checks.map(check => check.status), ['passed']);
        assert.notEqual(equal.checks[0].members[0].hitBox.height, equal.checks[0].members[1].hitBox.height);
        assert.notEqual(equal.checks[0].members[0].visualBox.width, equal.checks[0].members[1].visualBox.width);
        assert.deepEqual((await measureGroupAlignment(page)).checks, []);
    } finally {
        await page.close();
    }
});

test('checks wrapped flex lines independently and compares column widths only under a contract', async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(`
            <style>
                .row, .column { display: flex; gap: 1rem; }
                .row { flex-wrap: wrap; align-items: center; width: 21rem; }
                .row button { flex: 0 0 10rem; height: 2rem; }
                .row .large { height: 3rem; }
                .column { flex-direction: column; align-items: flex-start; direction: rtl; }
                button { border: thin solid black; background: white; }
            </style>
            <div class="row" role="toolbar">
                <button>One</button><button>Two</button>
                <button class="large">Three</button><button class="large">Four</button>
            </div>
            <div class="column" role="group">
                <button>One</button><button>Much longer label</button>
            </div>`);
        assert.deepEqual((await measureGroupAlignment(page)).checks, []);

        const expected = await measureGroupAlignment(page, [
            { groupSelector: '.row', crossSize: 'equal', alignment: 'center' },
            { groupSelector: '.column', crossSize: 'equal', alignment: 'start' },
        ]);
        assert.deepEqual(expected.checks.map(({ axis, line, status, differences }) => [axis, line, status, differences.map(diff => diff.kind)]), [
            ['row', 1, 'passed', []], ['row', 2, 'passed', []], ['column', 1, 'violation', ['cross-size']],
        ]);

        await page.addStyleTag({ content: '.column button:last-child { margin-inline-start: 1rem; }' });
        const shifted = await measureGroupAlignment(page, [{ groupSelector: '.column', crossSize: 'mixed', alignment: 'start' }]);
        assert.deepEqual(shifted.checks[0].differences.map(diff => diff.kind), ['alignment']);
    } finally {
        await page.close();
    }
});

test('records missing, hidden, invalid, clipped and unsupported groups as unverified without a hit-box substitute', async () => {
    const page = await browser.newPage();
    try {
        assert.equal(alignmentContractSchema.safeParse({ groupSelector: '#sample' }).success, false);
        await page.setContent(toolbar);
        assert.equal((await measureGroupAlignment(page, [{ groupSelector: '#absent', crossSize: 'equal' }])).checks[0].reason, 'group-not-found');
        assert.ok((await measureGroupAlignment(page, [{ groupSelector: '#sample', itemSelector: '!', crossSize: 'equal' }])).checks
            .some(check => check.status === 'unverified'));

        for (const [css, reason] of [
            ['#sample { display: none; }', 'group-not-visible'],
            ['#sample { display: grid; }', 'unsupported-group-layout'],
            ['.surface::before { scale: 1.1; }', 'visible-surface-could-not-be-measured'],
            ['.surface { clip-path: inset(25%); }', 'visible-surface-could-not-be-measured'],
        ]) {
            await page.setContent(toolbar);
            await page.addStyleTag({ content: css });
            const measured = await measureGroupAlignment(page, [{ groupSelector: '#sample', crossSize: 'equal' }]);
            assert.deepEqual(measured.checks.map(check => [check.status, check.reason, check.members.length]), [['unverified', reason, 0]]);
        }
        await page.setContent(toolbar);
        await page.addStyleTag({ content: '#sample > div { background-color: white; padding: 1rem; }' });
        const nested = await measureGroupAlignment(page, [{ groupSelector: '#sample', crossSize: 'equal' }]);
        assert.equal(nested.checks[0].members.length, 2);
    } finally {
        await page.close();
    }
});

const formRows = `
<style>
    body { font: 16px/1.6 sans-serif; }
    .row { display: grid; grid-template-columns: 260px 200px; align-items: start; gap: 16px; }
    .field { display: grid; gap: 8px; }
    .small-label label { font-size: 13px; }
    input, select, button { min-height: 44px; box-sizing: border-box; border: 1px solid #777; background: white; }
    .key-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-top: 24px; }
    .key-row > button { margin-top: 25px; }
    .key-row > label { width: 260px; }
</style>
<form>
    <div class="row">
        <div class="field"><label for="model">Model</label><input id="model" value="private-model-value"></div>
        <div class="field small-label">
            <label id="effort-label">Effort</label>
            <button type="button" role="combobox" aria-labelledby="effort-label">private-selection</button>
            <select aria-hidden="true" style="position:absolute;height:1px;min-height:0;width:1px"><option>private-option</option></select>
        </div>
    </div>
</form>
<form class="key-row">
    <label class="field">Key<input type="password" value="private-api-key"></label>
    <button type="button">Delete saved key</button>
</form>`;

async function inspectFormRows(page: Page) {
    const elements = await page.evaluateHandle(() => Array.from(document.querySelectorAll('input, select, button')));
    try { return await measureFormRowAlignment(page, elements); }
    finally { await elements.dispose(); }
}

test('measures signed top edges for a labeled field beside a combobox or same-form action without recording values', async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(formRows);
        const report = await inspectFormRows(page);
        assert.deepEqual(report.checks.map(check => [check.formPair, check.status]), [
            ['field-select','candidate'], ['field-action','candidate'],
        ]);
        assert.deepEqual(report.checks.map(check => check.differences), [
            [{kind:'alignment',spread:4.796875,signedTopOffset:-4.796875}],
            [{kind:'alignment',spread:8.59375,signedTopOffset:-8.59375}],
        ]);
        assert.deepEqual(report.checks.map(check => check.members.map(member => [
            member.elementRef,member.formRole,member.visualBox.height,
        ])), [[['e0','text-field',44],['e1','select',44]], [['e3','text-field',44],['e4','action-button',44]]]);
        assert(!JSON.stringify(report).includes('private-'));
        assert.equal((await measureGroupAlignment(page,[{groupSelector:'.key-row',itemSelector:'input, button',alignment:'start'}])).checks[0].status,'unverified');
    } finally { await page.close(); }
});

test('passes clean and sub-threshold form geometry and excludes wrapped, baseline-aligned, ambiguous or unrelated work', async () => {
    const page = await browser.newPage({deviceScaleFactor:2});
    try {
        await page.setContent(formRows);
        await page.addStyleTag({content:'.small-label label {font-size: 16px} .key-row > button {margin-top: 32.5px}'});
        assert.deepEqual((await inspectFormRows(page)).checks.map(check => [check.status,check.materialityThreshold]), [
            ['passed',2], ['passed',2],
        ]);
        await page.addStyleTag({content:'.row {align-items: baseline} .key-row {max-width: 280px}'});
        assert.deepEqual((await inspectFormRows(page)).checks,[]);

        await page.setContent(formRows);
        await page.locator('.row .field').first().evaluate(field => field.append(document.createElement('button')));
        await page.locator('.key-row > button').evaluate(button => button.setAttribute('type','submit'));
        assert.deepEqual((await inspectFormRows(page)).checks,[]);

        await page.setContent(formRows);
        await page.locator('.small-label button').evaluate(button => button.removeAttribute('aria-labelledby'));
        await page.locator('.key-row').evaluate(form => {
            const unrelated = document.createElement('div');
            form.replaceWith(unrelated);
            unrelated.className = form.className;
            unrelated.append(...form.children);
        });
        assert.deepEqual((await inspectFormRows(page)).checks,[]);
    } finally { await page.close(); }
});

test('measures the credential row with shared button identity scale and excludes a scaled button', async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(`
            <style>
                body { font: 16px/1.6 sans-serif; }
                .settings-credential { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 16px; }
                .gc-field { display: grid; gap: 8px; flex: 1 1 265px; min-width: 0; }
                .gc-input, .gc-button { min-height: 44px; box-sizing: border-box; border: 1px solid #777; background: white; }
                .gc-button { position: relative; scale: 1; margin-top: 25px; }
            </style>
            <form><fieldset><section><div class="settings-credential">
                <div class="gc-field">
                    <label for="key">API key</label>
                    <input class="gc-input" id="key" type="password" aria-describedby="key-help" value="private-key">
                    <small id="key-help">A key is stored.</small>
                </div>
                <button class="gc-button gc-button-secondary" type="button">
                    <span class="gc-button-content">Delete saved key</span>
                </button>
            </div></section></fieldset></form>`);
        const [measurement] = (await inspectFormRows(page)).checks;
        assert.equal(measurement?.formPair,'field-action');
        assert.equal(measurement.differences[0]?.signedTopOffset,-8.59375);
        assert(!JSON.stringify(measurement).includes('private-key'));
        await page.addStyleTag({content:'.gc-button { scale: .96; }'});
        assert.deepEqual((await inspectFormRows(page)).checks,[]);
    } finally { await page.close(); }
});
