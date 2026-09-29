import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage, MemoryStorage } from '../src/core/db';
import { Store } from '../src/core/store';
import { ValidationError, parseBackup, sniffMime } from '../src/core/validation';

// минимальные «валидные по сигнатуре» файлы
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const img = (name = 'a.jpg') => ({ name, blob: new Blob([JPEG], { type: 'image/jpeg' }), thumb: new Blob([JPEG], { type: 'image/jpeg' }), w: 100, h: 80 });

async function fresh(kind: 'mem' | 'idb') {
  const st = kind === 'mem' ? new MemoryStorage() : await IdbStorage.open();
  await st.clearAll(); // fake-indexeddb общий на весь файл
  const s = new Store(st);
  await s.init();
  await s.addCar({ name: 'Solaris', modelId: 'sedan-solaris', mileage: 1000 });
  return s;
}

describe.each(['mem', 'idb'] as const)('attachments (%s)', (kind) => {
  it('adds, reads back full blob, deletes', async () => {
    const s = await fresh(kind);
    const issue = await s.addIssue({ zoneId: 'hood', kind: 'rust', title: 'x' });
    const a = await s.addAttachment('issue', issue.id, img());
    expect(s.attachmentsByOwner.value.get(`issue:${issue.id}`)).toHaveLength(1);
    const blob = await s.getAttachmentBlob(a.id);
    expect(blob?.size).toBe(JPEG.length);
    await s.deleteAttachment(a.id);
    expect(s.attachments.value).toHaveLength(0);
    expect(await s.getAttachmentBlob(a.id)).toBeUndefined();
  });

  it('cascades: deleting a record deletes its photos; reopening removes log photos', async () => {
    const s = await fresh(kind);
    const i1 = await s.addIssue({ zoneId: 'hood', kind: 'dent', title: 'a' });
    const i2 = await s.addIssue({ zoneId: 'hood', kind: 'dent', title: 'b' });
    const p1 = await s.addAttachment('issue', i1.id, img());
    await s.completeIssue(i2.id, { date: '2026-01-01' });
    const log = s.logs.value.find((l) => l.ref?.id === i2.id)!;
    const p2 = await s.addAttachment('log', log.id, img());
    await s.reopenIssue(i2.id);
    expect(await s.getAttachmentBlob(p2.id)).toBeUndefined();
    await s.deleteIssue(i1.id);
    expect(await s.getAttachmentBlob(p1.id)).toBeUndefined();
    expect(s.attachments.value).toHaveLength(0);
  });

  it('enforces per-record limit and owner existence', async () => {
    const s = await fresh(kind);
    const i = await s.addIssue({ zoneId: 'hood', kind: 'rust', title: 'x' });
    for (let k = 0; k < 12; k++) await s.addAttachment('issue', i.id, img());
    await expect(s.addAttachment('issue', i.id, img())).rejects.toThrow(ValidationError);
    await expect(s.addAttachment('issue', 'nope', img())).rejects.toThrow(ValidationError);
  });

  it('deleting a car removes all its files', async () => {
    const s = await fresh(kind);
    const i = await s.addIssue({ zoneId: 'hood', kind: 'rust', title: 'x' });
    const a = await s.addAttachment('issue', i.id, img());
    await s.deleteCar(s.activeCar.value!.id);
    expect(await s.getAttachmentBlob(a.id)).toBeUndefined();
  });

  it('backup round-trip keeps photos', async () => {
    const s = await fresh(kind);
    const i = await s.addIssue({ zoneId: 'hood', kind: 'rust', title: 'x' });
    await s.addAttachment('issue', i.id, img('r.jpg'));
    const json = JSON.stringify(await s.exportSnapshot(true));
    const s2 = await fresh('mem');
    await s2.importBackup(parseBackup(JSON.parse(json)), 'replace');
    expect(s2.attachments.value).toHaveLength(1);
    const blob = await s2.getAttachmentBlob(s2.attachments.value[0].id);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(JPEG);
    expect(JSON.stringify(await s.exportSnapshot(false))).not.toContain('"attachments"');
  });
});

describe('backup attachment validation', () => {
  const base = { app: 'shtbox', version: 1, exportedAt: 'x', cars: [{ id: 'c', name: 'a', modelId: 'm' }], issues: [{ id: 'i', carId: 'c', zoneId: 'hood', kind: 'rust', title: 't' }] };
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const att = (o: object = {}) => ({ id: 'a1', carId: 'c', ownerType: 'issue', ownerId: 'i', name: 'x.jpg', mime: 'image/jpeg', size: 16, w: 10, h: 10, data: b64(JPEG), thumb: b64(JPEG), ...o });

  it('sniffs by magic bytes', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeUndefined();
  });
  it('rejects non-images, svg/html masquerading as jpeg, bad mime and bad base64', () => {
    const html = b64(new TextEncoder().encode('<html><script>alert(1)</script></html>'));
    expect(() => parseBackup({ ...base, attachments: [att({ data: html })] })).toThrow(ValidationError);
    expect(() => parseBackup({ ...base, attachments: [att({ mime: 'image/svg+xml' })] })).toThrow(ValidationError);
    expect(() => parseBackup({ ...base, attachments: [att({ data: '***' })] })).toThrow(ValidationError);
  });
  it('drops attachments whose owner is missing', () => {
    const r = parseBackup({ ...base, attachments: [att(), att({ id: 'a2', ownerId: 'ghost' })] });
    expect(r.attachments).toHaveLength(1);
  });
});
