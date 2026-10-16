// Fixed Foundation trash adapter, invoked by the locked shared worker only.
ObjC.import('Foundation');
function run(argv) {
  if (argv.length !== 1) throw Error('Invalid recycling invocation.');
  const manager = $.NSFileManager.defaultManager;
  const state = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Application Support/CodexDreamSkinStudio';
  const requests = state + '/manager-operations/trash-requests/';
  const request = argv[0];
  if (request.indexOf(requests) !== 0 || !/^[a-f0-9-]{36}\.json$/.test(request.slice(requests.length))) throw Error('Invalid recycling descriptor.');
  function safe(file) {
    const url = $.NSURL.fileURLWithPath(file);
    if (ObjC.unwrap(url.URLByResolvingSymlinksInPath.path) !== file) throw Error('Linked recycling paths are unsupported.');
    const err = Ref(), attrs = manager.attributesOfItemAtPathError(file, err);
    if (!attrs) throw Error('Recycling file is unavailable.');
    return attrs;
  }
  const attrs = safe(request);
  if (ObjC.unwrap(attrs.objectForKey($.NSFileType)) !== ObjC.unwrap($.NSFileTypeRegular) || Number(ObjC.unwrap(attrs.objectForKey($.NSFileSize))) > 16384) throw Error('Invalid recycling descriptor.');
  const error = Ref(), content = $.NSString.stringWithContentsOfFileEncodingError(request, $.NSUTF8StringEncoding, error);
  if (!content) throw Error('Recycling descriptor is unavailable.');
  const value = JSON.parse(ObjC.unwrap(content));
  if (value.schemaVersion !== 1 || value.location !== 'state' || !/^\.manager-library-delete-[a-f0-9-]{36}$/.test(value.name)) throw Error('Invalid preset recycling target.');
  const target = state + '/' + value.name;
  if (ObjC.unwrap(safe(target).objectForKey($.NSFileType)) !== ObjC.unwrap($.NSFileTypeDirectory)) throw Error('The isolated preset is unavailable.');
  const pending = [{file: target, depth: 0}]; let count = 0;
  while (pending.length) {
    const directory = pending.pop(); safe(directory.file);
    const listingError = Ref(), listing = manager.contentsOfDirectoryAtPathError(directory.file, listingError);
    if (!listing) throw Error('Preset recycling tree is unavailable.');
    const names = ObjC.unwrap(listing);
    for (let index = 0; index < names.length; index++) {
      if (++count > 4096 || directory.depth > 8) throw Error('Preset recycling tree exceeds its budget.');
      const member = directory.file + '/' + names[index], kind = ObjC.unwrap(safe(member).objectForKey($.NSFileType));
      if (kind === ObjC.unwrap($.NSFileTypeDirectory)) pending.push({file: member, depth: directory.depth + 1});
      else if (kind !== ObjC.unwrap($.NSFileTypeRegular)) throw Error('Special preset recycling files are unsupported.');
    }
  }
  const failure = Ref();
  if (!manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(target), null, failure)) throw Error('Could not recycle the isolated preset.');
  return JSON.stringify({ recycled: true });
}
