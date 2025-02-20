import videojs from 'video.js';
import window from 'global/window';
import { Parser as M3u8Parser } from 'm3u8-parser';
import { resolveUrl } from './resolve-url';
import { getLastParts, isAudioOnly } from './playlist.js';

const { log } = videojs;

export const createPlaylistID = (index, uri) => {
  return `${index}-${uri}`;
};

// default function for creating a group id
const groupID = (type, group, label) => {
  return `placeholder-uri-${type}-${group}-${label}`;
};

/**
 * Parses a given m3u8 playlist
 *
 * @param {Function} [onwarn]
 *        a function to call when the parser triggers a warning event.
 * @param {Function} [oninfo]
 *        a function to call when the parser triggers an info event.
 * @param {string} manifestString
 *        The downloaded manifest string
 * @param {Object[]} [customTagParsers]
 *        An array of custom tag parsers for the m3u8-parser instance
 * @param {Object[]} [customTagMappers]
 *        An array of custom tag mappers for the m3u8-parser instance
 * @param {boolean} [llhls]
 *        Whether to keep ll-hls features in the manifest after parsing.
 * @return {Object}
 *         The manifest object
 */
export const parseManifest = ({
  onwarn,
  oninfo,
  manifestString,
  customTagParsers = [],
  customTagMappers = [],
  llhls
}) => {
  const parser = new M3u8Parser();

  if (onwarn) {
    parser.on('warn', onwarn);
  }
  if (oninfo) {
    parser.on('info', oninfo);
  }

  customTagParsers.forEach(customParser => parser.addParser(customParser));
  customTagMappers.forEach(mapper => parser.addTagMapper(mapper));

  parser.push(manifestString);
  parser.end();

  const manifest = parser.manifest;

  // remove llhls features from the parsed manifest
  // if we don't want llhls support.
  if (!llhls) {
    [
      'preloadSegment',
      'skip',
      'serverControl',
      'renditionReports',
      'partInf',
      'partTargetDuration'
    ].forEach(function(k) {
      if (manifest.hasOwnProperty(k)) {
        delete manifest[k];
      }
    });

    if (manifest.segments) {
      manifest.segments.forEach(function(segment) {
        ['parts', 'preloadHints'].forEach(function(k) {
          if (segment.hasOwnProperty(k)) {
            delete segment[k];
          }
        });
      });
    }
  }
  if (!manifest.targetDuration) {
    let targetDuration = 10;

    if (manifest.segments && manifest.segments.length) {
      targetDuration = manifest
        .segments.reduce((acc, s) => Math.max(acc, s.duration), 0);
    }

    if (onwarn) {
      onwarn({ message: `manifest has no targetDuration defaulting to ${targetDuration}` });
    }
    manifest.targetDuration = targetDuration;
  }

  const parts = getLastParts(manifest);

  if (parts.length && !manifest.partTargetDuration) {
    const partTargetDuration = parts.reduce((acc, p) => Math.max(acc, p.duration), 0);

    if (onwarn) {
      onwarn({ message: `manifest has no partTargetDuration defaulting to ${partTargetDuration}` });
      log.error('LL-HLS manifest has parts but lacks required #EXT-X-PART-INF:PART-TARGET value. See https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis-09#section-4.4.3.7. Playback is not guaranteed.');
    }
    manifest.partTargetDuration = partTargetDuration;
  }

  return manifest;
};

/**
 * Loops through all supported media groups in main and calls the provided
 * callback for each group
 *
 * @param {Object} main
 *        The parsed main manifest object
 * @param {Function} callback
 *        Callback to call for each media group
 */
export const forEachMediaGroup = (main, callback) => {
  if (!main.mediaGroups) {
    return;
  }
  ['AUDIO', 'SUBTITLES'].forEach((mediaType) => {
    if (!main.mediaGroups[mediaType]) {
      return;
    }
    for (const groupKey in main.mediaGroups[mediaType]) {
      for (const labelKey in main.mediaGroups[mediaType][groupKey]) {
        const mediaProperties = main.mediaGroups[mediaType][groupKey][labelKey];

        callback(mediaProperties, mediaType, groupKey, labelKey);
      }
    }
  });
};

/**
 * Adds properties and attributes to the playlist to keep consistent functionality for
 * playlists throughout VHS.
 *
 * @param {Object} config
 *        Arguments object
 * @param {Object} config.playlist
 *        The media playlist
 * @param {string} [config.uri]
 *        The uri to the media playlist (if media playlist is not from within a main
 *        playlist)
 * @param {string} id
 *        ID to use for the playlist
 */
export const setupMediaPlaylist = ({ playlist, uri, id }) => {
  playlist.id = id;
  playlist.playlistErrors_ = 0;

  if (uri) {
    // For media playlists, m3u8-parser does not have access to a URI, as HLS media
    // playlists do not contain their own source URI, but one is needed for consistency in
    // VHS.
    playlist.uri = uri;
  }

  // For HLS main playlists, even though certain attributes MUST be defined, the
  // stream may still be played without them.
  // For HLS media playlists, m3u8-parser does not attach an attributes object to the
  // manifest.
  //
  // To avoid undefined reference errors through the project, and make the code easier
  // to write/read, add an empty attributes object for these cases.
  playlist.attributes = playlist.attributes || {};
};

/**
 * Adds ID, resolvedUri, and attributes properties to each playlist of the main, where
 * necessary. In addition, creates playlist IDs for each playlist and adds playlist ID to
 * playlist references to the playlists array.
 *
 * @param {Object} main
 *        The main playlist
 */
export const setupMediaPlaylists = (main) => {
  let i = main.playlists.length;

  while (i--) {
    const playlist = main.playlists[i];

    setupMediaPlaylist({
      playlist,
      id: createPlaylistID(i, playlist.uri)
    });
    playlist.resolvedUri = resolveUrl(main.uri, playlist.uri);
    main.playlists[playlist.id] = playlist;
    // URI reference added for backwards compatibility
    main.playlists[playlist.uri] = playlist;

    // Although the spec states an #EXT-X-STREAM-INF tag MUST have a BANDWIDTH attribute,
    // the stream can be played without it. Although an attributes property may have been
    // added to the playlist to prevent undefined references, issue a warning to fix the
    // manifest.
    if (!playlist.attributes.BANDWIDTH) {
      log.warn('Invalid playlist STREAM-INF detected. Missing BANDWIDTH attribute.');
    }
  }
};

/**
 * Adds resolvedUri properties to each media group.
 *
 * @param {Object} main
 *        The main playlist
 */
export const resolveMediaGroupUris = (main) => {
  forEachMediaGroup(main, (properties) => {
    if (properties.uri) {
      properties.resolvedUri = resolveUrl(main.uri, properties.uri);
    }
  });
};

/**
 * Creates a main playlist wrapper to insert a sole media playlist into.
 *
 * @param {Object} media
 *        Media playlist
 * @param {string} uri
 *        The media URI
 *
 * @return {Object}
 *         main playlist
 */
export const mainForMedia = (media, uri) => {
  const id = createPlaylistID(0, uri);
  const main = {
    mediaGroups: {
      'AUDIO': {},
      'VIDEO': {},
      'CLOSED-CAPTIONS': {},
      'SUBTITLES': {}
    },
    uri: window.location.href,
    resolvedUri: window.location.href,
    playlists: [{
      uri,
      id,
      resolvedUri: uri,
      // m3u8-parser does not attach an attributes property to media playlists so make
      // sure that the property is attached to avoid undefined reference errors
      attributes: {}
    }]
  };

  // set up ID reference
  main.playlists[id] = main.playlists[0];
  // URI reference added for backwards compatibility
  main.playlists[uri] = main.playlists[0];

  return main;
};

/**
 * Does an in-place update of the main manifest to add updated playlist URI references
 * as well as other properties needed by VHS that aren't included by the parser.
 *
 * @param {Object} main
 *        main manifest object
 * @param {string} uri
 *        The source URI
 * @param {function} createGroupID
 *        A function to determine how to create the groupID for mediaGroups
 */
export const addPropertiesToMain = (main, uri, createGroupID = groupID) => {
  main.uri = uri;

  for (let i = 0; i < main.playlists.length; i++) {
    if (!main.playlists[i].uri) {
      // Set up phony URIs for the playlists since playlists are referenced by their URIs
      // throughout VHS, but some formats (e.g., DASH) don't have external URIs
      // TODO: consider adding dummy URIs in mpd-parser
      const phonyUri = `placeholder-uri-${i}`;

      main.playlists[i].uri = phonyUri;
    }
  }
  const audioOnlyMain = isAudioOnly(main);

  forEachMediaGroup(main, (properties, mediaType, groupKey, labelKey) => {
    // add a playlist array under properties
    if (!properties.playlists || !properties.playlists.length) {
      // If the manifest is audio only and this media group does not have a uri, check
      // if the media group is located in the main list of playlists. If it is, don't add
      // placeholder properties as it shouldn't be considered an alternate audio track.
      if (audioOnlyMain && mediaType === 'AUDIO' && !properties.uri) {
        for (let i = 0; i < main.playlists.length; i++) {
          const p = main.playlists[i];

          if (p.attributes && p.attributes.AUDIO && p.attributes.AUDIO === groupKey) {
            return;
          }
        }
      }

      properties.playlists = [Object.assign({}, properties)];
    }

    properties.playlists.forEach(function(p, i) {
      const groupId = createGroupID(mediaType, groupKey, labelKey, p);
      const id = createPlaylistID(i, groupId);

      if (p.uri) {
        p.resolvedUri = p.resolvedUri || resolveUrl(main.uri, p.uri);
      } else {
        // DEPRECATED, this has been added to prevent a breaking change.
        // previously we only ever had a single media group playlist, so
        // we mark the first playlist uri without prepending the index as we used to
        // ideally we would do all of the playlists the same way.
        p.uri = i === 0 ? groupId : id;

        // don't resolve a placeholder uri to an absolute url, just use
        // the placeholder again
        p.resolvedUri = p.uri;
      }

      p.id = p.id || id;

      // add an empty attributes object, all playlists are
      // expected to have this.
      p.attributes = p.attributes || {};

      // setup ID and URI references (URI for backwards compatibility)
      main.playlists[p.id] = p;
      main.playlists[p.uri] = p;
    });

  });

  setupMediaPlaylists(main);
  resolveMediaGroupUris(main);
};
