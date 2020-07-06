/*
 Copyright (c) 2013, Yahoo! Inc.  All rights reserved.
 Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */
var istanbul = require('istanbul'),
    hook = istanbul.hook,
    Report = istanbul.Report,
    utils = istanbul.utils,
    Instrumenter = istanbul.Instrumenter,
    instrumenter = null,
    TreeSummarizer = istanbul.TreeSummarizer,
    baselineCoverage = {};

// var project_save_path = '/home/app/ddjf_interview_src'
var project_save_path = '/Users/ning/ddjf/js_coverage/f8app_coverage_demo/f8app_coverage_middleware/upload'
var path = require('path')
var fs = require('fs')
// 原有获取覆盖率数据的方法
// 这个方法是在内存中取出数据的
// 只可以获取当次的内容，无法完成多次测试的数据覆盖，所以进行了改造
//single place to get global coverage object
function getCoverageObject() {
    /*jslint nomen: true */
    global.__coverage__ = global.__coverage__ || {};
    return global.__coverage__;
}

// 直接修改getCoverageObject方法的成本太高了，需要修改的地方也非常多
// 所以直接新增一个方法，将global的数据设置成对应commit的数据
// 如此一来，只需要在每次点击commit的时候，启用这个方法，就能将覆盖率的数据替换成对应commit的数据
function setGlobalCoverage(commit_id) {
    var commit_path = path.join(project_save_path, commit_id)
        commit_file_path = path.join(commit_path, 'coverage_data.txt')
        coverage_data = {};
    // 异步读取会出现第一次加载无数据的情况，所以使用同步读取
    commit_data = fs.readFileSync(commit_file_path)
    if (commit_data) {
        global.__coverage__ = JSON.parse(commit_data)
    }
}

//returns a matcher that returns all JS files under root
//except when the file is anywhere under `node_modules`
//does not use istanbul.matcherFor() so as to expose
//a synchronous interface
function getRootMatcher(root) {
    return function (file) {
        if (file.indexOf(root) !== 0) { return false; }
        file = file.substring(root.length);
        if (file.indexOf('node_modules') >= 0) { return false; }
        return true;
    };
}

//deep-copy object
function clone(obj) {
    if (!obj) { return obj; }
    return JSON.parse(JSON.stringify(obj));
}
/**
 * save the baseline coverage stats for a file. This baseline is not 0
 * because of mainline code that is covered as part of loading the module
 * @method saveBaseline
 * @param file the file for which baseline stats need to be tracked.
 * @private
 */
function saveBaseline(file) {
    var coverageObject = getCoverageObject(),
        fileCoverage;
    if (coverageObject && coverageObject[file]) {
        fileCoverage = coverageObject[file];
        if (!baselineCoverage[file]) {
            baselineCoverage[file] = {
                s: clone(fileCoverage.s),
                f: clone(fileCoverage.f),
                b: clone(fileCoverage.b)
            };
        }
    }
}
/**
 * overwrites the coverage stats for the global coverage object to restore to baseline
 * @method restoreBaseline
 */
function restoreBaseline() {
    var cov = getCoverageObject(),
        fileCoverage,
        fileBaseline;
    Object.keys(baselineCoverage).forEach(function (file) {
        fileBaseline = baselineCoverage[file];
        if (cov[file]) {
            fileCoverage = cov[file];
            fileCoverage.s = clone(fileBaseline.s);
            fileCoverage.f = clone(fileBaseline.f);
            fileCoverage.b = clone(fileBaseline.b);
        }
    });
    Object.keys(cov).forEach(function (file) {
        if (!baselineCoverage[file]) { //throw it out
            delete cov[file];
        }
    });
}
/**
 * hooks `require` to add instrumentation to matching files loaded on the server
 * @method hookLoader
 * @param {Function|String} matcherOrRoot one of:
 *      a match function with signature `fn(file)` that returns true if `file` needs to be instrumented
 *      a root path under which all JS files except those under `node_modules` are instrumented
 * @param {Object} opts instrumenter options
 */
function hookLoader(matcherOrRoot, opts) {
    /*jslint nomen: true */
    var matcherFn,
        transformer,
        postLoadHook,
        postLoadHookFn;

    opts = opts || {};
    opts.coverageVariable = '__coverage__'; //force this always

    postLoadHook = opts.postLoadHook;
    if (!(postLoadHook && typeof postLoadHook === 'function')) {
        postLoadHook = function (/* matcher, transformer, verbose */) { return function (/* file */) {}; };
    }
    delete opts.postLoadHook;

    if (typeof matcherOrRoot === 'function') {
        matcherFn = matcherOrRoot;
    } else if (typeof matcherOrRoot === 'string') {
        matcherFn = getRootMatcher(matcherOrRoot);
    } else {
        throw new Error('Argument was not a function or string');
    }

    if (instrumenter) { return; } //already hooked
    instrumenter = new Instrumenter(opts);
    transformer = instrumenter.instrumentSync.bind(instrumenter);
    postLoadHookFn = postLoadHook(matcherFn, transformer, opts.verbose);

    hook.hookRequire(matcherFn, transformer, {
        verbose: opts.verbose,
        postLoadHook: function (file) {
            postLoadHookFn(file);
            saveBaseline(file);
        }
    });
}

function getTreeSummary(collector) {
    var summarizer = new TreeSummarizer();
    collector.files().forEach(function (key) {
        summarizer.addFileCoverageSummary(key, utils.summarizeFileCoverage(collector.fileCoverageFor(key)));
    });
    return summarizer.getTreeSummary();
}

function getPathMap(treeSummary) {
    var ret = {};

    function walker(node) {
        ret[node.fullPath()] = node;
        node.children.forEach(function (child) {
            walker(child);
        });
    }
    walker(treeSummary.root);
    return ret;
}

function render(filePath, res, prefix) {
    var collector = new istanbul.Collector(),
        treeSummary,
        pathMap,
        linkMapper,
        outputNode,
        report,
        fileCoverage,
        coverage = getCoverageObject();

    if (!(coverage && Object.keys(coverage).length > 0)) {
        res.setHeader('Content-type', 'text/plain');
        return res.end('No coverage information has been collected'); //TODO: make this a fancy HTML report
    }

    prefix = prefix || '';
    if (prefix.charAt(prefix.length - 1) !== '/') {
        prefix += '/';
    }

    utils.removeDerivedInfo(coverage);

    collector.add(coverage);
    treeSummary = getTreeSummary(collector);
    pathMap = getPathMap(treeSummary);

    filePath = filePath || treeSummary.root.fullPath();

    outputNode = pathMap[filePath];

    if (!outputNode) {
        res.statusCode = 404;
        return res.end('No coverage for file path [' + filePath + ']');
    }

    linkMapper = {
        hrefFor: function (node) {
            return prefix + 'show?p=' + node.fullPath();
        },
        fromParent: function (node) {
            return this.hrefFor(node);
        },
        ancestor: function (node, num) {
            var i;
            for (i = 0; i < num; i += 1) {
                node = node.parent;
            }
            return this.hrefFor(node);
        },
        asset: function (node, name) {
            return prefix + 'asset/' + name;
        }
    };

    report = Report.create('html', { linkMapper: linkMapper });
    res.setHeader('Content-type', 'text/html');
    if (outputNode.kind === 'dir') {
        report.writeIndexPage(res, outputNode);
    } else {
        fileCoverage = coverage[outputNode.fullPath()];
        utils.addDerivedInfoForFile(fileCoverage);
        report.writeDetailPage(res, outputNode, fileCoverage);
    }

    return res.end();
}

function mergeClientCoverage(obj) {
    if (!obj) { return; }
    var coverage = getCoverageObject();
        commit_id = obj.commit;
        coverage_data = obj.__coverage__;

    Object.keys(coverage_data).forEach(function (filePath) {
        var original = coverage[filePath],
            added = coverage_data[filePath],
            result;
        if (original) {
            result = utils.mergeFileCoverage(original, added);
        } else {
            result = added;
        }
        coverage[filePath] = result;
    });
    // 将代码覆盖率的数据都存储到指定目录的文本之中，方便后续的取出
    commit_path = path.join(project_save_path, commit_id)
    fs.mkdir(commit_path, {recursive:true}, (err)=>{
        if(err){
            throw err;
        }else{
            commit_file_path = path.join(commit_path, 'coverage_data.txt')
            fs.writeFile(commit_file_path, JSON.stringify(coverage_data), function(err) {
                if (err) {
                    console.log('failed mkdir ' + commit_file_path)
                }
            })
        }
    });
}


module.exports = {
    getCoverageObject: getCoverageObject,
    setGlobalCoverage: setGlobalCoverage,
    getInstrumenter: function () { return instrumenter; },
    restoreBaseline: restoreBaseline,
    hookLoader: hookLoader,
    render: render,
    mergeClientCoverage: mergeClientCoverage
};


