import {
    cloneDeep,
    forOwn,
    isArray,
    isBoolean,
    isEmpty,
    isError,
    isFunction,
    isObject,
    isPlainObject,
    isString,
    isUndefined,
    times,
} from 'lodash';
import * as gl from 'graphlib';
import path from 'path';
import * as PathLoader from '@rkesters/path-loader';
import * as qs from 'querystring';
import slash from './slash';
import { URIComponents } from 'uri-js';
import * as URI from 'uri-js';
import {
    DocumentNode,
    GeneralDocument,
    JsonRefsOptions,
    JsonRefsOptionsValidated,
    Metadata,
    RefLink,
    RefPtr,
    RefType,
    ResolvedRefDetails,
    ResolvedRefsResults,
    RetrievedResolvedRefsResults,
    UnresolvedRefDetails,
} from './typedefs';
import { isLoadOptions, LoadOptions, LoadOptionsBase, Response } from '@rkesters/path-loader';

const badPtrTokenRegex = /~(?:[^01]|$)/g;
let remoteCache: Record<
    string,
    { error?: Error; value?: GeneralDocument; refs?: Record<string, UnresolvedRefDetails> }
> = {};
const remoteTypes = ['relative', 'remote'];
const remoteUriTypes = ['absolute', 'uri'];
const uriDetailsCache: Record<string, URIComponents> = {};

/* Internal Functions */

function combineQueryParams(qs1: string, qs2: string): string {
    const combined = {};

    function mergeQueryParams(obj) {
        forOwn(obj, function (val, key) {
            combined[key] = val;
        });
    }

    mergeQueryParams(qs.parse(qs1 || ''));
    mergeQueryParams(qs.parse(qs2 || ''));

    return Object.keys(combined).length === 0 ? undefined : qs.stringify(combined);
}

function combineURIs(u1: string, u2: string) {
    // Convert Windows paths
    if (isString(u1)) {
        u1 = slash(u1);
    }

    if (isString(u2)) {
        u2 = slash(u2);
    }

    const u2Details: URIComponents = parseURI(isUndefined(u2) ? '' : u2);
    let u1Details: URIComponents;
    let combinedDetails: URIComponents;

    if (remoteUriTypes.indexOf(u2Details.reference) > -1) {
        combinedDetails = u2Details;
    } else {
        u1Details = isUndefined(u1) ? undefined : parseURI(u1);

        if (!isUndefined(u1Details)) {
            combinedDetails = u1Details;

            // Join the paths
            combinedDetails.path = slash(path.join(u1Details.path, u2Details.path));

            // Join query parameters
            combinedDetails.query = combineQueryParams(u1Details.query, u2Details.query);
        } else {
            combinedDetails = u2Details;
        }
    }

    // Remove the fragment
    combinedDetails.fragment = undefined;

    // For relative URIs, add back the '..' since it was removed above
    return (
        (remoteUriTypes.indexOf(combinedDetails.reference) === -1 && combinedDetails.path.indexOf('../') === 0
            ? '../'
            : '') + URI.serialize(combinedDetails)
    );
}

function findAncestors(obj: GeneralDocument | DocumentNode[], path: string[]): DocumentNode[] {
    const ancestors: DocumentNode[] = [];
    let node;

    if (path.length > 0) {
        node = obj;

        path.slice(0, path.length - 1).forEach(function (seg) {
            if (seg in node) {
                node = node[seg];

                ancestors.push(node);
            }
        });
    }

    return ancestors;
}

function isRemote(refDetails: UnresolvedRefDetails) {
    return remoteTypes.indexOf(getRefType(refDetails.uriDetails)) > -1;
}

function isValid(refDetails: UnresolvedRefDetails) {
    return isUndefined(refDetails.error) && refDetails.type !== 'invalid';
}

function findValue(obj: GeneralDocument | DocumentNode[], path: string[]) {
    let value: any = obj;

    // Using this manual approach instead of get since we have to decodeURI the segments
    path.forEach(function (seg) {
        if (seg in value) {
            value = value[seg];
        } else {
            throw Error('JSON Pointer points to missing location: ' + pathToPtr(path));
        }
    });

    return value;
}

function getExtraRefKeys(ref: GeneralDocument): string[] {
    return Object.keys(ref).filter(function (key) {
        return key !== '$ref';
    });
}

function getRefType(uriDetails: URIComponents): RefType {
    // Convert the URI reference to one of our types
    switch (uriDetails.reference) {
        case 'absolute':
        case 'uri':
            return 'remote';
        case 'same-document':
            return 'local';
        default:
            return uriDetails.reference;
    }
}

function setDefaultProcessContent(loaderOptions: LoadOptions | LoadOptionsBase): LoadOptions {
    // If there is no content processor, default to processing the raw response as JSON
    if (!isLoadOptions(loaderOptions)) {
        (loaderOptions as LoadOptions).processContent = function (res: Response, callback) {
            callback(undefined, JSON.parse(res.text));
        };
    }

    return loaderOptions as LoadOptions;
}

async function getRemoteDocument(url: string, options: JsonRefsOptionsValidated): Promise<GeneralDocument> {
    const loaderOptions: LoadOptions = setDefaultProcessContent(cloneDeep(options.loaderOptions ?? {}));

    const cacheEntry = remoteCache[url];

    if (!isUndefined(cacheEntry)) {
        if (isError(cacheEntry.error)) {
            throw cacheEntry.error;
        }

        return cloneDeep(cacheEntry.value);
    }

    try {
        // Attempt to load the resource using path-loader
        const res: GeneralDocument = await PathLoader.load<GeneralDocument>(decodeURI(url), loaderOptions);

        remoteCache[url] = {
            value: res,
        };

        return cloneDeep(res);
    } catch (err) {
        remoteCache[url] = {
            error: err,
        };

        throw err;
    }
}

function valiadteRefLike(obj: unknown) {
    if (!isPlainObject(obj)) {
        return 'obj is not an Object';
        // eslint-disable-next-line brace-style
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else if (!isString((obj as any).$ref)) {
        return 'obj.$ref is not a String';
    }
}

function isRefLike(obj: unknown): obj is RefLink {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return isPlainObject(obj) && isString((obj as any).$ref);
}

function makeAbsolute(location: string): string {
    if (location.indexOf('://') === -1 && !path.isAbsolute(location)) {
        return path.resolve(process.cwd(), location);
    } else {
        return location;
    }
}

function makeRefFilter(options: JsonRefsOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let validTypes = null;

    if (isArray(options.filter) || isString(options.filter)) {
        validTypes = isString(options.filter) ? [options.filter] : options.filter;
        if (options.includeInvalid) {
            validTypes.push('invalid');
        }
    } else if (isFunction(options.filter)) {
        validTypes = options.filter;
    }

    return function (refDetails: ResolvedRefDetails, path: string[]) {
        // eslint-disable-next-line no-nested-ternary
        const test: boolean = isArray(validTypes)
            ? validTypes.includes(refDetails.type) || validTypes.includes(getRefType(refDetails))
            : isFunction(validTypes)
            ? validTypes(refDetails, path)
            : true;

        return (refDetails.type !== 'invalid' || options.includeInvalid === true) && test;
    };
}

function makeSubDocPath(subDocPath: string | string[] | undefined) {
    if (isArray(subDocPath)) {
        return subDocPath;
    } else if (isString(subDocPath)) {
        return pathFromPtr(subDocPath);
    } else if (isUndefined(subDocPath)) {
        return [] as string[];
    }
}

function markMissing(refDetails: ResolvedRefDetails, err: Error) {
    refDetails.error = err.message;
    refDetails.missing = true;
}

function parseURI(uri: string): URIComponents {
    // We decode first to avoid doubly encoding
    return URI.parse(uri);
}

async function buildRefModel(
    document: GeneralDocument | DocumentNode[],
    options: JsonRefsOptionsValidated,
    metadata: Metadata = {
        deps: {}, // To avoid processing the same refernece twice, and for circular reference identification
        docs: {}, // Cache to avoid processing the same document more than once
        refs: {}, // Reference locations and their metadata
    }
): Promise<Metadata> {
    const subDocPtr = pathToPtr(options.subDocPath);
    const absLocation = makeAbsolute(options.location);
    const relativeBase = path.dirname(options.location);
    const docDepKey = absLocation + subDocPtr;

    // Store the document in the metadata if necessary
    if (isUndefined(metadata.docs[absLocation])) {
        metadata.docs[absLocation] = document;
    }

    // If there are no dependencies stored for the location+subDocPath, we've never seen it before and will process it
    if (isUndefined(metadata.deps[docDepKey])) {
        metadata.deps[docDepKey] = {};

        // Find the references based on the options
        const refs = findRefs(document, options);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let allTasks: Promise<any> = Promise.resolve();

        // Iterate over the references and process
        forOwn(refs, function (refDetails: ResolvedRefDetails, refPtr) {
            const refKey = makeAbsolute(options.location) + refPtr;
            const refdKey = (refDetails.refdId = decodeURIComponent(
                makeAbsolute(isRemote(refDetails) ? combineURIs(relativeBase, refDetails.uri) : options.location) +
                    '#' +
                    (refDetails.uri.indexOf('#') > -1 ? refDetails.uri.split('#')[1] : '')
            ));

            // Record reference metadata
            metadata.refs[refKey] = refDetails;

            // Do not process invalid references
            if (!isValid(refDetails)) {
                return;
            }

            // Record the fully-qualified URI
            refDetails.fqURI = refdKey;

            // Record dependency (relative to the document's sub-document path)
            metadata.deps[docDepKey][refPtr === subDocPtr ? '#' : refPtr.replace(subDocPtr + '/', '#/')] = refdKey;

            // Do not process directly-circular references (to an ancestor or self)
            if (refKey.indexOf(refdKey + '/') === 0 || refKey === refdKey) {
                refDetails.circular = true;

                return;
            }

            // Prepare the options for subsequent processDocument calls
            let rOptions = cloneDeep(options);

            rOptions.subDocPath = isUndefined(refDetails.uriDetails.fragment)
                ? []
                : pathFromPtr(decodeURIComponent(refDetails.uriDetails.fragment));

            // Resolve the reference
            if (isRemote(refDetails)) {
                // Delete filter.options because all remote references should be fully resolved
                delete rOptions.filter;
                rOptions = validateOptions(rOptions);
                // The new location being referenced
                rOptions.location = refdKey.split('#')[0];

                allTasks = allTasks.then(
                    (function (nMetadata, nOptions) {
                        return function () {
                            const rAbsLocation = makeAbsolute(nOptions.location);
                            const rDoc = nMetadata.docs[rAbsLocation];

                            if (isUndefined(rDoc)) {
                                // We have no cache so we must retrieve the document
                                return getRemoteDocument(rAbsLocation, nOptions).catch(function (err) {
                                    // Store the response in the document cache
                                    nMetadata.docs[rAbsLocation] = err;

                                    // Return the error to allow the subsequent `then` to handle both errors and successes
                                    return err;
                                });
                            } else {
                                // We have already retrieved (or attempted to) the document and should use the cached version in the
                                // metadata since it could already be processed some.
                                return Promise.resolve().then(function () {
                                    return rDoc;
                                });
                            }
                        };
                    })(metadata, rOptions)
                );
            } else {
                allTasks = allTasks.then(function () {
                    rOptions = cloneDeep(options);
                    return document;
                });
            }
            // rOptions.filter = options.filter;
            // Process the remote document or the referenced portion of the local document
            allTasks = allTasks
                .then((doc) => {
                    return doc;
                })
                .then(
                    (function (nMetadata, nOptions, nRefDetails) {
                        return function (doc) {
                            if (isError(doc)) {
                                markMissing(nRefDetails, doc);
                            } else {
                                // Wrapped in a try/catch since findRefs throws
                                try {
                                    return buildRefModel(doc, nOptions, nMetadata).catch(function (err) {
                                        markMissing(nRefDetails, err);
                                    });
                                } catch (err) {
                                    markMissing(nRefDetails, err);
                                }
                            }
                        };
                    })(metadata, rOptions, refDetails)
                );
        });

        return allTasks;
    }

    return metadata;
}

function setValue(obj: GeneralDocument | DocumentNode[] | Error, refPath: string[], value: DocumentNode) {
    if (isError(obj)) {
        return;
    }
    findValue(obj, refPath.slice(0, refPath.length - 1))[refPath[refPath.length - 1]] = value;
}

function walk(
    ancestors: DocumentNode[],
    node: DocumentNode,
    path: string[],
    fn: (ancestors: DocumentNode[], node: DocumentNode, path: string[]) => boolean
) {
    // eslint-disable-next-line @typescript-eslint/no-inferrable-types
    let processChildren: boolean = true;

    function walkItem(item, segment) {
        path.push(segment);
        walk(ancestors, item, path, fn);
        path.pop();
    }

    // Call the iteratee
    if (isFunction(fn)) {
        processChildren = fn(ancestors, node, path);
    }

    // We do not process circular objects again
    if (ancestors.indexOf(node) === -1) {
        ancestors.push(node);

        if (processChildren !== false) {
            if (isArray(node)) {
                node.forEach(function (member, index) {
                    walkItem(member, index.toString());
                });
            } else if (isObject(node)) {
                forOwn(node, function (cNode, key) {
                    walkItem(cNode, key);
                });
            }
        }

        ancestors.pop();
    }
}

function validateOptions(
    options: JsonRefsOptions = {},
    obj?: GeneralDocument | DocumentNode[]
): JsonRefsOptionsValidated {
    // Clone the options so we do not alter the ones passed in
    options = cloneDeep(options);

    if (!isObject(options)) {
        throw new TypeError('options must be an Object');
    }
    if (!isUndefined(options.resolveCirculars) && !isBoolean(options.resolveCirculars)) {
        throw new TypeError('options.resolveCirculars must be a Boolean');
    }
    if (
        !isUndefined(options.filter) &&
        !isArray(options.filter) &&
        !isFunction(options.filter) &&
        !isString(options.filter)
    ) {
        throw new TypeError('options.filter must be an Array, a Function of a String');
    }
    if (!isUndefined(options.includeInvalid) && !isBoolean(options.includeInvalid)) {
        throw new TypeError('options.includeInvalid must be a Boolean');
    }
    if (!isUndefined(options.location) && !isString(options.location)) {
        throw new TypeError('options.location must be a String');
    }
    if (!isUndefined(options.refPreProcessor) && !isFunction(options.refPreProcessor)) {
        throw new TypeError('options.refPreProcessor must be a Function');
    }

    if (!isUndefined(options.refPostProcessor) && !isFunction(options.refPostProcessor)) {
        throw new TypeError('options.refPostProcessor must be a Function');
    }

    if (!isUndefined(options.subDocPath) && !isArray(options.subDocPath) && !isPtr(options.subDocPath)) {
        // If a pointer is provided, throw an error if it's not the proper type
        throw new TypeError('options.subDocPath must be an Array of path segments or a valid JSON Pointer');
    }

    // Default to false for allowing circulars
    options.resolveCirculars = options.resolveCirculars ?? false;
    options.filter = makeRefFilter(options);

    // options.location is not officially supported yet but will be when Issue 88 is complete
    options.location = options.location ?? makeAbsolute('./root.json');

    // If options.location contains a fragment, turn it into an options.subDocPath
    if (options.location.includes('#')) {
        const locationParts = options.location.split('#');

        // Set the subDocPath to avoid everyone else having to compute it
        options.subDocPath = `#${locationParts[1]}`;
    }

    const shouldDecode: boolean = decodeURI(options.location) === options.location;

    // Just to be safe, remove any accidental fragment as it would break things
    options.location = combineURIs(options.location, undefined);

    // If the location was not encoded, meke sure it's not when we get it back (Issue #138)
    if (shouldDecode) {
        options.location = decodeURI(options.location);
    }

    options.subDocPath = makeSubDocPath(options.subDocPath);
    if (!isUndefined(obj)) {
        try {
            findValue(obj, options.subDocPath);
        } catch (err) {
            err.message = err.message.replace('JSON Pointer', 'options.subDocPath');
            throw err;
        }
    }

    return options as JsonRefsOptionsValidated;
}

/**
 * Takes an array of path segments and decodes the JSON Pointer tokens in them.
 *
 * @param {string[]} path - The array of path segments
 *
 * @returns {string[]} the array of path segments with their JSON Pointer tokens decoded
 *
 * @throws {Error} if the path is not an `Array`
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 */
export function decodePath(path: string[]) {
    if (!isArray(path)) {
        throw new TypeError('path must be an array');
    }

    const r = path.map(function (seg) {
        if (!isString(seg)) {
            seg = JSON.stringify(seg);
        }

        return seg.replace(/~1/g, '/').replace(/~0/g, '~');
    });

    return r;
}

/**
 * Takes an array of path segments and encodes the special JSON Pointer characters in them.
 *
 * @param {string[]} path - The array of path segments
 *
 * @returns {string[]} the array of path segments with their JSON Pointer tokens encoded
 *
 * @throws {Error} if the path is not an `Array`
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 */
export function encodePath(path: string[]) {
    if (!isArray(path)) {
        throw new TypeError('path must be an array');
    }

    return path.map(function (seg) {
        if (!isString(seg)) {
            seg = JSON.stringify(seg);
        }

        return seg.replace(/~/g, '~0').replace(/\//g, '~1');
    });
}

/**
 * Finds JSON References defined within the provided array/object.
 *
 * @param {array|object} obj - The structure to find JSON References within
 * @param {module:json-refs.JsonRefsOptions} [opts] - The JsonRefs options
 *
 * @returns {Object.<string, module:json-refs.UnresolvedRefDetails|undefined>} an object whose keys are JSON Pointers
 * *(fragment version)* to where the JSON Reference is defined and whose values are {@link UnresolvedRefDetails}.
 *
 * @throws {Error} when the input arguments fail validation or if `options.subDocPath` points to an invalid location
 *
 * @example
 * // Finding all valid references
 * var allRefs = JsonRefs.findRefs(obj);
 * // Finding all remote references
 * var remoteRefs = JsonRefs.findRefs(obj, {filter: ['relative', 'remote']});
 * // Finding all invalid references
 * var invalidRefs = JsonRefs.findRefs(obj, {filter: 'invalid', includeInvalid: true});
 */
export function findRefs(
    obj: GeneralDocument | DocumentNode[],
    opts?: JsonRefsOptions
): Record<string, UnresolvedRefDetails> {
    const refs: Record<string, UnresolvedRefDetails> = {};

    // Validate the provided document
    if (!isArray(obj) && !isObject(obj)) {
        throw new TypeError('obj must be an Array or an Object');
    }

    // Validate options
    const options = validateOptions(opts, obj);

    // Walk the document (or sub document) and find all JSON References
    walk(
        findAncestors(obj, options.subDocPath),
        findValue(obj, options.subDocPath),
        cloneDeep(options.subDocPath),
        function (ancestors, node, path) {
            let processChildren = true;
            let refDetails: UnresolvedRefDetails;
            let refPtr;

            if (isRefLike(node)) {
                // Pre-process the node when necessary
                if (!isUndefined(options.refPreProcessor)) {
                    node = options.refPreProcessor(cloneDeep(node), path);
                }

                refDetails = getRefDetails(node);

                // Post-process the reference details
                if (!isUndefined(options.refPostProcessor)) {
                    refDetails = options.refPostProcessor(refDetails, path);
                }

                if (options.filter(refDetails, path)) {
                    refPtr = pathToPtr(path);

                    refs[refPtr] = refDetails;
                }

                // Whenever a JSON Reference has extra children, its children should not be processed.
                //   See: http://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03#section-3
                if (getExtraRefKeys(node).length > 0) {
                    processChildren = false;
                }
            }

            return processChildren;
        }
    );

    return refs;
}

export function validatePtr(ptr: unknown): string | undefined {
    if (isString(ptr)) {
        if (!isEmpty(ptr)) {
            const firstChar = ptr[0];

            if (['#', '/'].indexOf(firstChar) === -1) {
                return 'ptr must start with a / or #/';
            }
            if (firstChar === '#' && ptr !== '#' && ptr.charAt(1) !== '/') {
                return 'ptr must start with a / or #/';
            }
            if (ptr.match(badPtrTokenRegex)) {
                return 'ptr has invalid token(s)';
            }
        }
        return;
    }
    return 'ptr is not a String';
}

/**
 * Returns whether the argument represents a JSON Pointer.
 *
 * A string is a JSON Pointer if the following are all true:
 *
 *   * The string is of type `String`
 *   * The string must be empty, `#` or start with a `/` or `#/`
 *
 * @param {unknown} ptr - The string to check
 * @param {boolean} [throwWithDetails=false] - Whether or not to throw an `Error` with the details as to why the value
 * provided is invalid
 *
 * @returns {boolean} the result of the check
 *
 * @throws {error} when the provided value is invalid and the `throwWithDetails` argument is `true`
 *
 * @see {@link https://tools.ietf.org/html/rfc6901#section-3}
 *
 * @example
 * // Separating the different ways to invoke isPtr for demonstration purposes
 * if (isPtr(str)) {
 *   // Handle a valid JSON Pointer
 * } else {
 *   // Get the reason as to why the value is not a JSON Pointer so you can fix/report it
 *   try {
 *     isPtr(str, true);
 *   } catch (err) {
 *     // The error message contains the details as to why the provided value is not a JSON Pointer
 *   }
 * }
 */
export function isPtr(ptr: unknown, throwWithDetails = false): ptr is RefPtr {
    const r: string | undefined = validatePtr(ptr);

    if (!r) {
        return true;
    }
    if (!throwWithDetails) {
        return false;
    }
    throw new Error(r);
}

/**
 * Returns whether the argument represents a JSON Reference.
 *
 * An object is a JSON Reference only if the following are all true:
 *
 *   * The object is of type `Object`
 *   * The object has a `$ref` property
 *   * The `$ref` property is a valid URI *(We do not require 100% strict URIs and will handle unescaped special
 *     characters.)*
 *
 * @param {object} obj - The object to check
 * @param {boolean} [throwWithDetails=false] - Whether or not to throw an `Error` with the details as to why the value
 * provided is invalid
 *
 * @returns {boolean} the result of the check
 *
 * @throws {error} when the provided value is invalid and the `throwWithDetails` argument is `true`
 *
 * @see {@link http://tools.ietf.org/html/draft-pbryan-zyp-json-ref-03#section-3}
 *
 * @example
 * // Separating the different ways to invoke isRef for demonstration purposes
 * if (isRef(obj)) {
 *   // Handle a valid JSON Reference
 * } else {
 *   // Get the reason as to why the value is not a JSON Reference so you can fix/report it
 *   try {
 *     isRef(str, true);
 *   } catch (err) {
 *     // The error message contains the details as to why the provided value is not a JSON Reference
 *   }
 * }
 */
export function isRef(obj: unknown): obj is RefLink {
    return isRefLike(obj) && getRefDetails(obj).type !== 'invalid';
}

/**
 * Returns an array of path segments for the provided JSON Pointer.
 *
 * @param {string} ptr - The JSON Pointer
 *
 * @returns {string[]} the path segments
 *
 * @throws {Error} if the provided `ptr` argument is not a JSON Pointer
 */
export function pathFromPtr(ptr: RefPtr): string[] {
    if (!isPtr(ptr)) {
        throw new Error(`ptr must be a JSON Pointer: ${validatePtr(ptr)}`);
    }

    const segments = ptr.split('/');

    // Remove the first segment
    segments.shift();

    return decodePath(segments);
}

/**
 * Returns a JSON Pointer for the provided array of path segments.
 *
 * **Note:** If a path segment in `path` is not a `String`, it will be converted to one using `JSON.stringify`.
 *
 * @param {string[]} path - The array of path segments
 * @param {boolean} [hashPrefix=true] - Whether or not create a hash-prefixed JSON Pointer
 *
 * @returns {string} the corresponding JSON Pointer
 *
 * @throws {Error} if the `path` argument is not an array
 */
export function pathToPtr(path: string[], hashPrefix = true): string {
    if (!isArray(path)) {
        throw new Error('path must be an Array');
    }

    // Encode each segment and return
    return (hashPrefix !== false ? '#' : '') + (path.length > 0 ? '/' : '') + encodePath(path).join('/');
}

/**
 * Finds JSON References defined within the provided array/object and resolves them.
 *
 * @param {array|object} doc - The structure to find JSON References within
 * @param {module:json-refs.JsonRefsOptions} [opts] - The JsonRefs options
 *
 * @returns {Promise<module:json-refs.ResolvedRefsResults>} a promise that resolves a
 * {@link module:json-refs.ResolvedRefsResults} and rejects with an `Error` when the input arguments fail validation,
 * when `options.subDocPath` points to an invalid location or when the location argument points to an unloadable
 * resource
 *
 * @example
 * // Example that only resolves relative and remote references
 * JsonRefs.resolveRefs(swaggerObj, {
 *     filter: ['relative', 'remote']
 *   })
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.resolved: The document with the appropriate JSON References resolved
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
export async function resolveRefs(
    doc: GeneralDocument | DocumentNode[],
    opts?: JsonRefsOptions
): Promise<ResolvedRefsResults> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allTasks: Promise<any> = Promise.resolve();

    if (!isArray(doc) && !isObject(doc)) {
        throw new TypeError('obj must be an Array or an Object');
    }

    // Validate options
    const options = validateOptions(opts, doc);

    // Clone the input so we do not alter it
    const obj = cloneDeep(doc);

    allTasks = allTasks
        .then(function () {
            const metadata: Metadata = {
                deps: {}, // To avoid processing the same refernece twice, and for circular reference identification
                docs: {}, // Cache to avoid processing the same document more than once
                refs: {}, // Reference locations and their metadata
            };

            return buildRefModel(obj, options, metadata).then(function () {
                return metadata;
            });
        })
        .then(function (results) {
            const allRefs: Record<string, ResolvedRefDetails> = {};
            let circularPaths: string[][] = [];
            const circulars = [];
            const depGraph = new gl.Graph();
            const fullLocation = makeAbsolute(options.location);
            const refsRoot = fullLocation + pathToPtr(options.subDocPath);
            const relativeBase = path.dirname(fullLocation);

            // Identify circulars

            // Add nodes first
            Object.keys(results.deps).forEach(function (node) {
                depGraph.setNode(node);
            });

            // Add edges
            forOwn(results.deps, function (props, node) {
                forOwn(props, function (dep) {
                    depGraph.setEdge(node, dep);
                });
            });

            circularPaths = gl.alg.findCycles(depGraph);

            // Create a unique list of circulars
            circularPaths.forEach(function (path) {
                path.forEach(function (seg) {
                    if (circulars.indexOf(seg) === -1) {
                        circulars.push(seg);
                    }
                });
            });

            // Identify circulars
            forOwn(results.deps, function (props, node) {
                forOwn(props, function (dep, prop) {
                    let isCircular = false;
                    const refPtr = node + prop.slice(1);
                    const refDetails = results.refs[node + prop.slice(1)];
                    const remote = isRemote(refDetails);
                    let pathIndex;

                    if (circulars.indexOf(dep) > -1) {
                        // Figure out if the circular is part of a circular chain or just a reference to a circular
                        circularPaths.forEach(function (path) {
                            // Short circuit
                            if (isCircular) {
                                return;
                            }

                            pathIndex = path.indexOf(dep);

                            if (pathIndex > -1) {
                                // Check each path segment to see if the reference location is beneath one of its segments
                                path.forEach(function (seg) {
                                    // Short circuit
                                    if (isCircular) {
                                        return;
                                    }

                                    if (refPtr.indexOf(seg + '/') === 0) {
                                        // If the reference is local, mark it as circular but if it's a remote reference, only mark it
                                        // circular if the matching path is the last path segment or its match is not to a document root
                                        if (!remote || pathIndex === path.length - 1 || dep[dep.length - 1] !== '#') {
                                            isCircular = true;
                                        }
                                    }
                                });
                            }
                        });
                    }

                    if (isCircular) {
                        // Update all references and reference details
                        refDetails.circular = true;
                    }
                });
            });

            // Resolve the references in reverse order since the current order is top-down
            forOwn(Object.keys(results.deps).reverse(), function (parentPtr: string) {
                const deps = results.deps[parentPtr];
                const pPtrParts = parentPtr.split('#');
                const pDocument = results.docs[pPtrParts[0]];
                const pPtrPath = pathFromPtr(pPtrParts[1]);

                forOwn(deps, function (dep, prop) {
                    const depParts = splitFragment(dep);
                    const dDocument = results.docs[depParts[0]];
                    const dPtrPath = pPtrPath.concat(pathFromPtr(prop));
                    const refDetails = results.refs[pPtrParts[0] + pathToPtr(dPtrPath)];

                    // Resolve reference if valid
                    if (isUndefined(refDetails.error) && isUndefined(refDetails.missing) && !isError(dDocument)) {
                        if (!options.resolveCirculars && refDetails.circular) {
                            refDetails.value = cloneDeep(refDetails.def);
                        } else {
                            try {
                                refDetails.value = findValue(dDocument, pathFromPtr(depParts[1]));
                            } catch (err) {
                                markMissing(refDetails, err);

                                return;
                            }

                            // If the reference is at the root of the document, replace the document in the cache.  Otherwise, replace
                            // the value in the appropriate location in the document cache.
                            if (pPtrParts[1] === '' && prop === '#') {
                                results.docs[pPtrParts[0]] = refDetails.value;
                            } else {
                                setValue(pDocument as GeneralDocument, dPtrPath, refDetails.value);
                            }
                        }
                    }
                });
            });

            function walkRefs(root, refPtr, refPath) {
                const refPtrParts = refPtr.split('#');
                const refDetails = results.refs[refPtr];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let refDeps: Record<string, any>;

                // Record the reference (relative to the root document unless the reference is in the root document)
                allRefs[
                    refPtrParts[0] === options.location
                        ? '#' + refPtrParts[1]
                        : pathToPtr(options.subDocPath.concat(refPath))
                ] = refDetails;

                // Do not walk invalid references
                if (refDetails.circular || !isValid(refDetails)) {
                    // Sanitize errors
                    if (!refDetails.circular && refDetails.error) {
                        // The way we use findRefs now results in an error that doesn't match the expectation
                        refDetails.error = refDetails.error.replace('options.subDocPath', 'JSON Pointer');

                        // Update the error to use the appropriate JSON Pointer
                        if (refDetails.error.indexOf('#') > -1) {
                            refDetails.error = refDetails.error.replace(
                                refDetails.uri.substr(refDetails.uri.indexOf('#')),
                                refDetails.uri
                            );
                        }

                        // Report errors opening files as JSON Pointer errors
                        if (refDetails.error.indexOf('ENOENT:') === 0 || refDetails.error.indexOf('Not Found') === 0) {
                            refDetails.error = 'JSON Pointer points to missing location: ' + refDetails.uri;
                        }
                    }

                    return;
                }

                // eslint-disable-next-line prefer-const
                refDeps = results.deps[refDetails.refdId];

                if (refDetails.refdId.indexOf(root) !== 0) {
                    Object.keys(refDeps).forEach(function (prop) {
                        walkRefs(
                            refDetails.refdId,
                            refDetails.refdId + prop.substr(1),
                            refPath.concat(pathFromPtr(prop))
                        );
                    });
                }
            }

            // For performance reasons, we only process a document (or sub document) and each reference once ever.  This means
            // that if we want to provide the full picture as to what paths in the resolved document were created as a result
            // of a reference, we have to take our fully-qualified reference locations and expand them to be all local based
            // on the original document.
            Object.keys(results.refs).forEach(function (refPtr) {
                const refDetails = results.refs[refPtr];
                let fqURISegments: string[];
                let uriSegments: string[];

                // Make all fully-qualified reference URIs relative to the document root (if necessary).  This step is done here
                // for performance reasons instead of below when the official sanitization process runs.
                if (refDetails.type !== 'invalid') {
                    // Remove the trailing hash from document root references if they weren't in the original URI
                    if (
                        refDetails.fqURI[refDetails.fqURI.length - 1] === '#' &&
                        refDetails.uri[refDetails.uri.length - 1] !== '#'
                    ) {
                        refDetails.fqURI = refDetails.fqURI.substr(0, refDetails.fqURI.length - 1);
                    }

                    fqURISegments = refDetails.fqURI.split('/');
                    uriSegments = refDetails.uri.split('/');

                    // The fully-qualified URI is unencoded so to keep the original formatting of the URI (encoded vs. unencoded),
                    // we need to replace each URI segment in reverse order.
                    times(uriSegments.length - 1, function (time) {
                        const nSeg = uriSegments[uriSegments.length - time - 1];
                        const pSeg = uriSegments[uriSegments.length - time];
                        const fqSegIndex = fqURISegments.length - time - 1;

                        if (nSeg === '.' || nSeg === '..' || pSeg === '..') {
                            return;
                        }

                        fqURISegments[fqSegIndex] = nSeg;
                    });

                    refDetails.fqURI = fqURISegments.join('/');

                    // Make the fully-qualified URIs relative to the document root
                    if (refDetails.fqURI.indexOf(fullLocation) === 0) {
                        refDetails.fqURI = refDetails.fqURI.replace(fullLocation, '');
                    } else if (refDetails.fqURI.indexOf(relativeBase) === 0) {
                        refDetails.fqURI = refDetails.fqURI.replace(relativeBase, '');
                    }

                    if (refDetails.fqURI[0] === '/') {
                        refDetails.fqURI = '.' + refDetails.fqURI;
                    }
                }

                // We only want to process references found at or beneath the provided document and sub-document path
                if (refPtr.indexOf(refsRoot) !== 0) {
                    return;
                }

                walkRefs(refsRoot, refPtr, pathFromPtr(refPtr.substr(refsRoot.length)));
            });

            // Sanitize the reference details
            forOwn(allRefs, function (refDetails: ResolvedRefDetails, refPtr) {
                // Delete the reference id used for dependency tracking and circular identification
                delete refDetails.refdId;

                // For locally-circular references, update the $ref to be fully qualified (Issue #175)
                if (refDetails.circular && refDetails.type === 'local') {
                    refDetails.value.$ref = refDetails.fqURI;

                    setValue(results.docs[fullLocation], pathFromPtr(refPtr), refDetails.value);
                }

                // To avoid the error message being URI encoded/decoded by mistake, replace the current JSON Pointer with the
                // value in the JSON Reference definition.
                if (refDetails.missing) {
                    refDetails.error = refDetails.error.split(': ')[0] + ': ' + refDetails.def.$ref;
                }
            });

            return {
                refs: allRefs,
                resolved: results.docs[fullLocation],
            };
        });

    return allTasks;
}
/**
 * Resolves JSON References defined within the document at the provided location.
 *
 * This API is identical to {@link module:json-refs.resolveRefs} except this API will retrieve a remote document and
 * then return the result of {@link module:json-refs.resolveRefs} on the retrieved document.
 *
 * @param {string} location - The location to retrieve *(Can be relative or absolute, just make sure you look at the
 * {@link module:json-refs.JsonRefsOptions|options documentation} to see how relative references are handled.)*
 * @param {module:json-refs.JsonRefsOptions} [opts] - The JsonRefs options
 *
 * @returns {Promise<module:json-refs.RetrievedResolvedRefsResults>} a promise that resolves a
 * {@link module:json-refs.RetrievedResolvedRefsResults} and rejects with an `Error` when the input arguments fail
 * validation, when `options.subDocPath` points to an invalid location or when the location argument points to an
 * unloadable resource
 *
 * @example
 * // Example that loads a JSON document (No options.loaderOptions.processContent required) and resolves all references
 * JsonRefs.resolveRefsAt('./swagger.json')
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.resolved: The document with the appropriate JSON References resolved
 *      // res.value: The retrieved document
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
export async function resolveRefsAt(
    location: string,
    opts: JsonRefsOptions = {}
): Promise<RetrievedResolvedRefsResults> {
    // Validate the provided location
    if (!isString(location)) {
        throw new TypeError('location must be a string');
    }
    // Add the location to the options for processing/validation
    opts.location = location;

    // Validate options
    const options = validateOptions(opts);
    const res = await getRemoteDocument(options.location, options);

    return resolveRefs(res, options).then(function (res2: ResolvedRefsResults) {
        return {
            refs: res2.refs,
            resolved: res2.resolved,
            value: res,
        };
    });
}

// splits a fragment from a URI using the first hash found
export function splitFragment(uri) {
    const hash = uri.indexOf('#');

    if (hash < 0) {
        return [uri];
    }
    const parts = [];

    parts.push(uri.substring(0, hash));
    parts.push(uri.substring(hash + 1));
    return parts;
}

/**
 * Returns detailed information about the JSON Reference.
 *
 * @param {object} obj - The JSON Reference definition
 *
 * @returns {module:json-refs.UnresolvedRefDetails} the detailed information
 */
export function getRefDetails(obj: GeneralDocument): UnresolvedRefDetails {
    const details: UnresolvedRefDetails = {
        def: obj,
    } as UnresolvedRefDetails;

    // This will throw so the result doesn't matter
    if (!isRefLike(obj)) {
        details.error = valiadteRefLike(obj);
        details.type = 'invalid';
        return details;
    }

    const cacheKey = obj.$ref;
    const uriDetails = uriDetailsCache[cacheKey] ?? parseURI(cacheKey);

    details.uri = cacheKey;
    details.uriDetails = uriDetails;

    if (isUndefined(uriDetails.error)) {
        details.type = getRefType(details.uriDetails);

        if ((cacheKey.startsWith('#') || cacheKey.startsWith('/')) && !isPtr(cacheKey)) {
            details.error = validatePtr(cacheKey);
            details.type = 'invalid';
        } else if (cacheKey.includes('#') && !isPtr(uriDetails.fragment)) {
            details.error = validatePtr(cacheKey);
            details.type = 'invalid';
        }
    } else {
        details.error = details.uriDetails.error;
        details.type = 'invalid';
    }

    // Identify warning
    const extraKeys = getExtraRefKeys(obj);

    if (extraKeys.length > 0) {
        details.warning = `Extra JSON Reference properties will be ignored: ${extraKeys.join(', ')}`;
    }

    return details;
}

/**
 * Finds JSON References defined within the document at the provided location.
 *
 * This API is identical to {@link findRefs} except this API will retrieve a remote document and then
 * return the result of {@link findRefs} on the retrieved document.
 *
 * @param {string} location - The location to retrieve *(Can be relative or absolute, just make sure you look at the
 * {@link module:json-refs.JsonRefsOptions|options documentation} to see how relative references are handled.)*
 * @param {module:json-refs.JsonRefsOptions} [opts] - The JsonRefs options
 *
 * @returns {Promise<module:json-refs.RetrievedRefsResults>} a promise that resolves a
 * {@link module:json-refs.RetrievedRefsResults} and rejects with an `Error` when the input arguments fail validation,
 * when `options.subDocPath` points to an invalid location or when the location argument points to an unloadable
 * resource
 *
 * @example
 * // Example that only resolves references within a sub document
 * JsonRefs.findRefsAt('http://petstore.swagger.io/v2/swagger.json', {
 *     subDocPath: '#/definitions'
 *   })
 *   .then(function (res) {
 *      // Do something with the response
 *      //
 *      // res.refs: JSON Reference locations and details
 *      // res.value: The retrieved document
 *   }, function (err) {
 *     console.log(err.stack);
 *   });
 */
export async function findRefsAt(location: string, opts: JsonRefsOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allTasks: Promise<any> = Promise.resolve();

    opts.location = location;
    // Validate options
    const options = validateOptions(opts);

    allTasks = allTasks
        .then(function () {
            // Validate the provided location
            if (!isString(location)) {
                throw new TypeError('options.location must be a String');
            }

            return getRemoteDocument(options.location, options);
        })
        .then(function (res) {
            const cacheEntry = cloneDeep(remoteCache[options.location]);
            let cOptions = cloneDeep(options);

            if (isUndefined(cacheEntry.refs)) {
                // Do not filter any references so the cache is complete
                delete cOptions.filter;
                delete cOptions.subDocPath;

                cOptions.includeInvalid = true;
                cOptions = validateOptions(cOptions);
                remoteCache[options.location].refs = findRefs(res, cOptions);
            }

            cOptions.filter = options.filter;
            // This will use the cache so don't worry about calling it twice
            return {
                refs: findRefs(res, cOptions),
                value: res,
            };
        });

    return allTasks;
}

/**
 * Clears the internal cache of remote documents, reference details, etc.
 */
export function clearCache() {
    remoteCache = {};
}
