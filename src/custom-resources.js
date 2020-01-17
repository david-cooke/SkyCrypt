const fs = require('fs-extra');
const path = require('path');
const mm = require('micromatch');
const objectPath = require('object-path');
const escapeRegExp = require('lodash.escaperegexp');
const sharp = require('sharp');
const { createCanvas, loadImage } = require('canvas');
const mcData = require("minecraft-data")("1.8.9");
const UPNG = require('upng-js');
const RJSON = require('relaxed-json');

const NORMALIZED_SIZE = 128;

const RESOURCE_PACK_FOLDER = path.resolve(__dirname, '..', 'public', 'resourcepacks');

let removeFormatting = new RegExp('§[0-9a-z]{1}', 'g');

async function getFiles(dir, fileList){
    const files = await fs.readdir(dir);

    fileList = fileList || [];

    for(const file of files){
        let fileStat = await fs.stat(path.resolve(dir, file));

        if(await fileStat.isDirectory())
            fileList = await getFiles(path.resolve(dir, file), fileList);
        else
            fileList.push(path.resolve(dir, file));
    }

    return fileList;
}

function getFrame(src, frame){
    const dst = createCanvas(NORMALIZED_SIZE, NORMALIZED_SIZE);
    const ctx = dst.getContext("2d");

    ctx.drawImage(src, 0, frame * NORMALIZED_SIZE * -1);

    return dst;
}

let resourcePacks = [];

async function init(){
     for(const pack of await fs.readdir(RESOURCE_PACK_FOLDER)){
        let basePath = path.resolve(RESOURCE_PACK_FOLDER, pack);
        let config = require(path.resolve(basePath, 'config.json'));

        resourcePacks.push({
            basePath,
            config
        });
    }

    resourcePacks = resourcePacks.sort((a, b) => a.config.priority - b.config.priority);

    for(let pack of resourcePacks){
        pack.files = await getFiles(path.resolve(pack.basePath, 'assets', 'minecraft', 'mcpatcher', 'cit'));
        pack.textures = [];

        for(const file of pack.files){
            if(path.extname(file) != '.properties')
                continue;

            let lines = fs.readFileSync(file, 'utf8').split("\r\n");
            let properties = {};

            for(let line of lines){
                let split = line.split("=");

                if(split.length < 2)
                    continue;

                properties[split[0]] = split.slice(1).join("=");
            }

            if(!('type' in properties))
                continue;

            if(!properties.type == 'item')
                continue;

            let texture = {weight: 0, animated: false, file: path.basename(file), match: []};

            let textureFile = 'texture' in properties
            ? path.resolve(path.dirname(file), properties.texture)
            : path.resolve(path.dirname(file), path.basename(file, '.properties'));

            if(!textureFile.endsWith('.png'))
                textureFile += '.png';

            if('texture.bow_standby' in properties)
                textureFile = path.resolve(path.dirname(file), properties['texture.bow_standby']);

            if('model' in properties){
                const modelFile = path.resolve(path.dirname(file), properties['model']);

                try{
                    const model = RJSON.parse(await fs.readFile(modelFile, 'utf8'));

                    if(model.parent == 'builtin/generated'){
                        const layers = Object.keys(model.textures).sort((a, b) => a - b);
                        const topLayer = layers.pop();

                        if(topLayer.startsWith('layer')){
                            const layerPath = path.resolve(pack.basePath, 'assets', 'minecraft', model.textures[topLayer] + '.png');
                            await fs.access(layerPath, fs.F_OK);

                            textureFile = layerPath;
                        }
                    }
                }catch(e){
                    //
                }
            }

            try{
                await fs.access(textureFile, fs.F_OK);
            }catch(e){
                continue;
            }

            texture.path = textureFile;

            const textureImage = sharp(textureFile);
            const textureMetadata = await textureImage.metadata();

            if(textureMetadata.width != NORMALIZED_SIZE)
                await
                    fs.writeFile(textureFile, await
                        textureImage
                        .resize(NORMALIZED_SIZE, textureMetadata.height * (NORMALIZED_SIZE / textureMetadata.width), {
                            kernel: sharp.kernel.nearest
                        })
                        .toBuffer()
                    );

            if(UPNG.decode(await fs.readFile(textureFile)).frames.length > 0)
                texture.animated = true;

            for(let property in properties){
                if(property == 'weight')
                    texture.weight = parseInt(properties[property]);

                if(property == 'items'){
                    let item = mcData.findItemOrBlockByName(properties[property].replace('minecraft:', ''));

                    if(item)
                        texture.id = item.id;
                }

                if(property == 'damage')
                    texture.damage = parseInt(properties[property]);

                if(!property.startsWith('nbt.'))
                    continue;

                let regex = properties[property];

                if(regex.startsWith('ipattern:')){
                    regex = mm.makeRe(regex.substring(9), { nocase: true });
                }else if(regex.startsWith('pattern:')){
                    regex = mm.makeRe(regex.substring(9));
                }else if(regex.startsWith('iregex:')){
                    regex = new RegExp(regex.substring(7), 'i');
                }else if(regex.startsWith('regex:')){
                    regex = new RegExp(regex.substring(6));
                }else{
                    regex = new RegExp(escapeRegExp(regex));
                }

                texture.match.push({
                    value: property.substring(4),
                    regex
                });
            }

            let mcMeta;

            try{
                mcMeta = await fs.readFile(textureFile + '.mcmeta', 'utf8');
            }catch(e){
                mcMeta = false;
            }

            let metaProperties = {};

            if(mcMeta){
                try{
                    metaProperties = RJSON.parse(mcMeta);
                }catch(e){
                    //
                }
            }

            if('animation' in metaProperties && textureMetadata.width != textureMetadata.height){
                texture.animated = true;

                const { animation } = metaProperties;
                const canvas = createCanvas(NORMALIZED_SIZE, NORMALIZED_SIZE);
                const ctx = canvas.getContext('2d');

                const image = await loadImage(textureFile);

                const pngFrames = [];
                const pngDelays = [];

                if(!('frames' in animation)){
                    animation.frames = [];

                    for(let i = 0; i < image.height / NORMALIZED_SIZE; i++)
                        animation.frames.push(i);
                }

                let currentTime = 0;

                for(const [index, frame] of animation.frames.entries()){
                    if(typeof frame == 'number')
                        animation.frames[index] = {
                            index: frame,
                            time: animation.frametime
                        };

                    animation.frames[index].time = animation.frames[index].time / 20 * 1000;
                    animation.frames[index].totalTime = currentTime;
                    currentTime += animation.frames[index].time;
                }

                animation.frametime = animation.frametime / 20 * 1000;

                if('frames' in animation){
                    let frameCount = animation.frames.length;

                    if(animation.interpolate){
                        let totalLength = 0;

                        for(const frame of animation.frames)
                            totalLength += frame.time;

                        const frameTimeInterpolated = 2 / 20 * 1000;

                        let frameCountInterpolated = totalLength / frameTimeInterpolated;

                        for(let i = 0; i < frameCountInterpolated; i++){
                            let frameCur, frameNext;
                            let currentTime = i / frameCountInterpolated * totalLength;

                            for(const [index, frame] of animation.frames.entries()){
                                if(frame.totalTime + frame.time > currentTime){
                                    frameCur = frame;

                                    if(index >= animation.frames.length - 1)
                                        frameNext = animation.frames[0];
                                    else
                                        frameNext = animation.frames[index + 1];

                                    break;
                                }
                            }

                            const opacity = (currentTime - frameCur.totalTime) / frameCur.time;

                            ctx.clearRect(0, 0, canvas.width, canvas.height);

                            ctx.globalCompositeOperation = 'source-over';

                            ctx.globalAlpha = 1;
                            ctx.drawImage(getFrame(image, frameCur.index), 0, 0);

                            ctx.globalCompositeOperation = 'source-atop';

                            ctx.globalAlpha = opacity;
                            ctx.drawImage(getFrame(image, frameNext.index), 0, 0);

                            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer;

                            pngFrames.push(imageData);
                            pngDelays.push(frameTimeInterpolated);
                        }
                    }else{
                        for(const frame of animation.frames){
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(getFrame(image, frame.index), 0, 0);

                            pngDelays.push(frame.time);

                            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer;

                            pngFrames.push(imageData);
                        }
                    }
                }

                if(pngFrames.length > 0){
                    const apng = UPNG.encode(pngFrames, NORMALIZED_SIZE, NORMALIZED_SIZE, 0, pngDelays);

                    await fs.writeFile(textureFile, Buffer.from(apng));
                }
            }

            pack.textures.push(texture);
        }
    }
}

const readyPromise = init();

readyPromise.then(() => {
    module.exports.ready = true;
});

module.exports = {
    ready: false,
    getTexture: async item => {
        if(!module.exports.ready)
            await readyPromise;

        let outputTexture = { weight: -9999 };

        for(const pack of resourcePacks){
            if('weight' in outputTexture)
                outputTexture.weight = -9999;

            for(const texture of pack.textures){
                if(texture.id != item.id)
                    continue;

                if('damage' in texture && texture.damage != item.Damage)
                    continue;

                let matches = 0;

                for(const match of texture.match){
                    let {value, regex} = match;

                    if(value.endsWith('.*'))
                        value = value.substring(0, value.length - 2);

                    if(!objectPath.has(item, 'tag.' + value))
                        continue;

                    let matchValues = objectPath.get(item, 'tag.' + value);

                    if(!Array.isArray(matchValues))
                        matchValues = [matchValues];

                    for(const matchValue of matchValues){
                        if(!regex.test(matchValue.toString().replace(removeFormatting, '')))
                            continue;

                        matches++;
                    }
                }

                if(matches == texture.match.length){
                    if(texture.weight < outputTexture.weight)
                        continue;

                    if(texture.weight == outputTexture.weight && texture.file < outputTexture.file)
                        continue;

                    outputTexture = Object.assign({}, texture);
                }
            }
        }

        if(!('path' in outputTexture))
            return null;

        outputTexture.path = path.relative(path.resolve(__dirname, '..', 'public'), outputTexture.path);

        return outputTexture;
    }
}