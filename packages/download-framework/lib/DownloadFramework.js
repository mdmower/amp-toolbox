/**
 * Copyright 2020 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const Caches = require('@ampproject/toolbox-cache-list');
const crossFetch = require('cross-fetch');
const fs = require('fs');
const https = require('https');
const log = require('@ampproject/toolbox-core').log.tag('AMP Download Framework');
const os = require('os');
const path = require('path');
const runtimeVersionProvider = require('@ampproject/toolbox-runtime-version');
const {URL} = require('url');
const util = require('util');

const readdir = util.promisify(fs.readdir);
const rmdir = util.promisify(fs.rmdir);
const unlink = util.promisify(fs.unlink);

const FRAMEWORK_FILES_TXT = 'files.txt';
const fetchOptions = {
  agent: new https.Agent({
    keepAlive: true,
    maxSockets: 6,
  }),
  compress: true,
};

class DownloadFramework {
  constructor(fetch) {
    this.fetch_ = fetch || crossFetch;
  }

  /**
   * Download the AMP framework.
   *
   * @param {Object} options - the options.
   * @param {string} options.dest - path to directory where AMP framework should be saved.
   * @param {bool} options.clear - disable clearing destination directory before saving.
   * @param {string} options.rtv - the runtime version of the AMP framework.
   * @param {string} options.ampUrlPrefix - absolute URL to the AMP framework.
   * @return {Promise<Object>} a promise that resolves with data about the download.
   *
   * The return object includes the success or failure status, as well as data about the AMP
   * framework that was downloaded:
   * {
   *   status {boolean} Overall AMP framework download status
   *   error {string} Error message on failure
   *   count {number} Number of files in the AMP framework
   *   url {string} URL to AMP framework
   *   dest {string} Path to directory where AMP framework was downloaded
   *   rtv {string} Runtime version of AMP framework
   * }
   */
  async getFramework(options = {}) {
    const {clear} = options;
    let {ampUrlPrefix, dest, rtv} = options;

    // Prepare response object
    const ret = {
      status: false,
      error: '',
      count: 0,
      url: '',
      dest: dest,
      rtv: '',
    };

    // Expand ~ if it is the first path segment and non-Windows.
    // TODO: There's room for improvement in detecting which environments need this.
    if (os.type() != 'Windows_NT') {
      if (dest.split(path.sep)[0] === '~') {
        dest = dest.replace('~', os.homedir());
        ret.dest = dest;
      }
    }

    // Verify destination directory was specified and is writable
    try {
      this.assertDirectoryWritable_(dest);
    } catch (ex) {
      ret.error = ex.message;
      log.error(ret.error);
      return ret;
    }

    // Verify RTV is URL compatible if specified, otherwise fetch RTV from AMP
    // framework cache (using ampUrlPrefix if specified).
    if (!rtv) {
      rtv = await runtimeVersionProvider.currentVersion({ampUrlPrefix});
      if (!rtv) {
        ret.error = 'Could not determine runtime version to download';
        log.error(ret.error);
        return ret;
      }
    } else if (rtv !== encodeURIComponent(rtv)) {
      ret.error = 'Invalid runtime version specified: ' + rtv;
      log.error(ret.error);
      return ret;
    }

    ret.rtv = rtv;
    log.info('AMP framework runtime version: ' + rtv);

    // If AMP framework cache was specified, verify it is an absolute URL.
    // Otherwise, assume Google's AMP framework cache.
    if (!ampUrlPrefix) {
      const googleAmpCache = await Caches.get('google');
      if (!googleAmpCache) {
        ret.error = 'Could not determine AMP cache domain';
        log.error(ret.error);
        return ret;
      }
      ampUrlPrefix = 'https://' + googleAmpCache.cacheDomain;
    } else if (!this.isAbsoluteUrl_(ampUrlPrefix)) {
      ret.error = 'ampUrlPrefix must be an absolute URL';
      log.error(ret.error);
      return ret;
    }

    // Construct URLs to RTV-specific AMP framework and files listing
    const frameworkBaseUrl =
      ampUrlPrefix + (ampUrlPrefix.endsWith('/') ? '' : '/') + `rtv/${rtv}/`;
    const filesTxtUrl = frameworkBaseUrl + FRAMEWORK_FILES_TXT;

    ret.url = frameworkBaseUrl;
    log.info('AMP framework base URL: ' + frameworkBaseUrl);

    // Fetch files listing and generate URLs to each file
    let files;
    try {
      const res = await this.fetch_(filesTxtUrl);
      if (!res.ok) {
        ret.error = 'Unable to fetch AMP framework files listing: ' + filesTxtUrl;
        log.error(ret.error);
        return ret;
      }
      const text = await res.text();
      files = text
          .split(/\r?\n/)
          .filter((filepath) => filepath)
          .map((filepath) => {
            return {
              filepath,
              url: frameworkBaseUrl + filepath,
            };
          });

      // Minimal sanity check that files listing includes itself
      if (!files.some((file) => file.filepath === FRAMEWORK_FILES_TXT)) {
        throw new Error(`Expected ${FRAMEWORK_FILES_TXT} in file listing, but it was not found.`);
      }
    } catch (ex) {
      ret.error = 'Unable to read AMP framework files listing\n' + ex.message;
      log.error(ret.error);
      return ret;
    }

    ret.count = files.length;
    log.info(`AMP framework contains ${files.length} files`);

    // Clear destination directory by default, but allow user to disable feature
    if (clear !== false) {
      await this.clearDirectory_(dest);
    }

    // Create all subdirectories in destination directory
    this.createSubdirectories_(files, dest);

    log.info('Downloading AMP framework...');

    // Fetch all AMP framework files and save them in the destination dir.
    // Note: fetchOptions sets maxSockets, limiting the number of concurrent
    // downloads, so this isn't as crazy as it might appear.
    const fetchAndSavePromises =
      files.map((file) => this.fetchAndSaveAsync_(file, dest));

    // Wait for all downloads to finish
    await Promise.all(fetchAndSavePromises)
        .then(() => {
          ret.status = true;
          log.info('AMP framework download complete: ' + dest);
        })
        .catch((error) => {
          ret.error = 'Failed to download AMP framework\n' + error.message;
          log.error(ret.error);
        });

    return ret;
  }

  /* PRIVATE */

  /**
   * Verify path points to a writable directory. Attempt to create directory
   * if it does not yet exist. Throw on error.
   *
   * @param {string} dirpath - path to directory.
   */
  assertDirectoryWritable_(dirpath) {
    if (!dirpath) {
      throw new Error('Directory not specified');
    }
    if (!fs.existsSync(dirpath) || !fs.lstatSync(dirpath).isDirectory()) {
      // Attempt to create directory
      log.info('Creating destination directory: ' + dirpath);
      fs.mkdirSync(dirpath, {recursive: true});
    }
    fs.accessSync(dirpath, fs.constants.R_OK | fs.constants.W_OK);
  }

  /**
   * Remove all contents from a directory.
   *
   * @param {string} dirpath - path to directory.
   */
  async clearDirectory_(dirpath) {
    log.info('Clearing destination directory');
    const contents = await readdir(dirpath, {withFileTypes: true});
    const unlinkPromises = contents.map(async (item) => {
      if (item.isDirectory()) {
        await rmdir(path.join(dirpath, item.name), {recursive: true});
      } else {
        await unlink(path.join(dirpath, item.name));
      }
    });
    return Promise.all(unlinkPromises);
  }

  /**
   * Determine whether a URL is absolute.
   *
   * @param {string} url - URL to test.
   * @return {bool}
   */
  isAbsoluteUrl_(url) {
    try {
      new URL(url);
      return true;
    } catch (ex) { }

    return false;
  }

  /**
   * Create any subdirectories needed for AMP framework files.
   *
   * @param {Array} files - all files in AMP framework.
   * @param {Object} files[n] - individual AMP framework file data.
   * @param {string} files[n].filepath - relative path to AMP framework file.
   * @param {string} files[n].url - absolute URL to AMP framework file.
   * @param {string} dest - directory under which subdirectories should be created.
   */
  createSubdirectories_(files, dest) {
    // Identify relative directory for each file
    const dirs = files.map((file) => path.dirname(file.filepath));

    // Retain only unique relative directories
    const uniqueDirs = dirs.filter((dir, idx) => dir !== '.' && dirs.indexOf(dir) === idx);

    uniqueDirs.forEach((dir) => {
      // Convert path separators to match platform (maybe not necessary)
      dir = dir.split('/').join(path.sep);

      // Construct full path to directory in destination dir
      const fullpath = path.join(dest, dir);

      // Create new directories, recursively
      if (!fs.existsSync(fullpath)) {
        fs.mkdirSync(fullpath, {recursive: true});
      }
    });
  }

  /**
   * Fetch an AMP framework file and save it to disk.
   *
   * @param {Object} file - individual AMP framework file data.
   * @param {string} file.filepath - relative path to AMP framework file.
   * @param {string} file.url - absolute URL to AMP framework file.
   * @param {string} dest - directory under which subdirectories should be created.
   * @param {Promise}
   */
  async fetchAndSaveAsync_(file, dest) {
    const {filepath, url} = file;
    const fullpath = path.join(dest, filepath);

    // Fetch file
    const res = await this.fetch_(url, fetchOptions);
    if (!res.ok) {
      return Promise.reject(new Error('Failed to fetch ' + url));
    }

    // Prepare promise to indicate completion
    let resolve;
    let reject;
    const savePromise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // File fetched successfully, so open file stream
    const wstream = fs.createWriteStream(fullpath);

    // If this file is amp-geo.js, then undo the {{AMP_ISO_COUNTRY_HOTPATCH}}
    // hotpatch before saving. Otherwise, stream the file directly to disk.
    if (/amp-geo-([\d.]+|latest)\.m?js/.test(filepath)) {
      const text = (await res.text()).replace(/[a-z]{2} {26}/i, '{{AMP_ISO_COUNTRY_HOTPATCH}}');
      wstream.write(text, wstream.close.bind(wstream));
    } else {
      res.body.pipe(wstream);
      res.body.on('error', reject);
    }

    wstream.on('finish', resolve);
    wstream.on('error', reject);

    return await savePromise;
  }
}

module.exports = DownloadFramework;
