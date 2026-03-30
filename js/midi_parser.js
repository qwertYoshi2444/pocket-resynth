'use strict';
/**
 * midi_parser.js — Lightweight MIDI (SMF) Parser
 * Extracts pure Note On/Off data with absolute start time, duration, and track information.
 */
class MidiParser {
  /**
   * @param {ArrayBuffer} buffer 
   * @returns {Array} [{ note: number, start: number, duration: number, track: number }]
   */
  static parse(buffer) {
    const data = new Uint8Array(buffer);
    let offset = 0;

    const readString = (len) => { let s=''; for(let i=0; i<len; i++) s+=String.fromCharCode(data[offset++]); return s; };
    const read16 = () => (data[offset++] << 8) | data[offset++];
    const read32 = () => (data[offset++] << 24) | (data[offset++] << 16) | (data[offset++] << 8) | data[offset++];
    const readVarInt = () => {
      let val = 0;
      while (true) {
        const b = data[offset++];
        val = (val << 7) | (b & 0x7F);
        if ((b & 0x80) === 0) return val;
      }
    };

    if (readString(4) !== 'MThd') throw new Error('Not a valid MIDI file');
    const headerLen = read32();
    const format = read16();
    const numTracks = read16();
    const ticksPerBeat = read16();
    offset = 14;

    let tempo = 500000; // 120 BPM default
    const noteEvents = [];

    for (let t = 0; t < numTracks; t++) {
      if (readString(4) !== 'MTrk') throw new Error('Invalid track chunk');
      const trackLen = read32();
      const trackEnd = offset + trackLen;

      let ticks = 0;
      let lastStatus = 0;
      const activeNotes = new Map(); // note -> startTicks

      while (offset < trackEnd) {
        const delta = readVarInt();
        ticks += delta;

        let status = data[offset];
        if (status >= 0x80) {
          lastStatus = status;
          offset++;
        } else {
          status = lastStatus;
        }

        const eventType = status >> 4;
        const channel = status & 0x0F;

        if (eventType === 0x0F) { // Meta or SysEx
          if (status === 0xFF) {
            const metaType = data[offset++];
            const len = readVarInt();
            if (metaType === 0x51 && len === 3) { // Set Tempo
              const newTempo = (data[offset]<<16) | (data[offset+1]<<8) | data[offset+2];
              if (t === 0 && ticks === 0) tempo = newTempo; // 初回のテンポのみ採用
              offset += len;
            } else {
              offset += len;
            }
          } else {
            const len = readVarInt();
            offset += len;
          }
        } else {
          // Channel Event
          if (eventType === 0x8 || eventType === 0x9) {
            const note = data[offset++];
            const vel = data[offset++];
            
            if (eventType === 0x9 && vel > 0) {
              // Note On
              if (!activeNotes.has(note)) activeNotes.set(note, ticks);
            } else {
              // Note Off (0x8 or 0x9 with vel=0)
              if (activeNotes.has(note)) {
                const startTicks = activeNotes.get(note);
                // トラック番号 t を付与して保存
                noteEvents.push({ note, startTicks, endTicks: ticks, track: t });
                activeNotes.delete(note);
              }
            }
          } else if (eventType === 0xC || eventType === 0xD) {
            offset += 1;
          } else if (eventType === 0xA || eventType === 0xB || eventType === 0xE) {
            offset += 2;
          }
        }
      }
    }

    // Ticks to Seconds conversion
    // Note: Tempo map is flattened (ignores mid-song tempo changes)
    const secPerTick = (tempo / 1000000) / ticksPerBeat;
    
    return noteEvents.map(e => ({
      note: e.note,
      start: e.startTicks * secPerTick,
      duration: (e.endTicks - e.startTicks) * secPerTick,
      track: e.track
    })).sort((a, b) => a.start - b.start);
  }
}