const { exec } = require('child_process'),
fs = require('fs'),
uuid = require('uuid/v1'),
request = require('request'),
ffmpeg = require('fluent-ffmpeg');
process.chdir(__dirname);

var supportedTypes = ['.wav','.mp3','.mp4'], // Add more if needed
maxSize = 10485760; // 10MB


module.exports = function (context, req) {
    context.log('Request received: analyzing audio file at'+req.query.url);
    
    if (!req.query.url) {
       context.log("Please pass an audio or video file in the url parameter");
       context.res = {status: 400, body: "Please pass an audio or video file in the url parameter"};
       context.done(); 
       return;
    }

    var url = req.query.url,
    filetype = url.match(/\.([^.]*)$/g)[0], // Filetype regex
    filename = uuid(); // Unique ID (needed for parallel functions in same storage)
    
    var arousal,
    valence;
    
    // Step 0: Check filetype, size, download and convert if neccessary
    if (supportedTypes.indexOf(filetype) >= 0) {
        request({
            url: url,
            method: "HEAD"
        }, function(err, headRes){
            var size = headRes.headers['content-length'];
            if (size > maxSize) {
                context.log('Resource size exceeds limit (' + size + ')');
            } else {
                var res = request.get(url)
                    .on('error', function(err) {
                        context.log(err);
                    })
                    .pipe(fs.createWriteStream(filename+filetype))
                    .on('finish', function () {
                        if (filetype == '.wav') {
                            extract();
                        } else {
                            ffmpeg(filename+filetype)
                            .setFfmpegPath('scripts\\ffmpeg.exe')
                            .toFormat('wav')
                            .on('error', function (err) {
                                context.log('An error occurred in converting: ' + err.message);
                            })
                            .on('progress', function (progress) {
                                context.log('Processing conversion: ' + progress.targetSize + ' KB converted');
                            })
                            .on('end', function () {
                                context.log('Conversion finished !');
                                fs.unlink(filename+filetype, function(err){
                                    if(err) return context.log(err);
                                    context.log('Original audio file deleted successfully');
                                });
                                extract();
                            })
                            .save(filename+'.wav');
                        }
                    });
            }     
        })
        .on('error', function(err) {
            context.log(err);
        });
    } else {
        context.log("This filetype is not supported")
    }

    // Step 1: extract audio features
    function extract(){
        context.log("extracting audio features");
        exec(`"scripts\\SMILExtract.exe" -C "scripts\\mfcc_energy.conf" -logfile "${filename}-smile.log" -I "${filename}.wav" -instname "${filename}.wav" -csvoutput "${filename}-LLD.csv" -l 0`, (err, stdout, stderr) => {
            if (err || (stderr != '')){
                context.log(stderr + err.message);
                cleanup();
            } else {
                context.log("succesfully extracted.");
                parse();
                }
        });
    }

    // Step 2: parsing
    function parse(){
       context.log("Parsing audio features against codebook");
       
       exec(`"D:\\Program Files (x86)\\Java\\jdk1.8.0_73\\bin\\java.exe" -jar "scripts\\openXBOW.jar" -i ${filename}-LLD.csv -attributes nt1[13] -o ${filename}-boaw.libsvm -norm 1 -b "scripts\\codebook"`, (err, stdout, stderr) => {
        if (err || (stderr != '')){
            context.log(stderr + err);
            cleanup();
        } else {
            context.log("succesfully parsed.");
            predict();
            }
        })
    }

    // Step 3: predict
    function predict(){
        context.log("Predicting values");
        
        exec(`scripts\\predict.exe ${filename}-boaw.libsvm "scripts\\modelArousal.svr" ${filename}-arousal.txt`, (err, stdout, stderr) => {
         if (err || (stderr != '')){
             context.log(stderr + err);
             cleanup();
         } else {
             context.log("succesfully predicted arousal.");     
                exec(`scripts\\predict.exe ${filename}-boaw.libsvm "scripts\\modelValence.svr" ${filename}-valence.txt`, (err, stdout, stderr) => {
                    if (err || (stderr != '')){
                        context.log(stderr + err.message);
                    } else {
                        context.log("succesfully predicted valence.");
                        returnvalues();
                    }
                })
             }
         })
     }

    // Step 4: return values
    function returnvalues() {
        fs.readFile(`${filename}-valence.txt`, 'utf8', function (err, data) {
            if (err) throw err;
            context.log("valence: " + data);
            valence = data;
            fs.unlink(`${filename}-valence.txt`, function (err) {
                if (err) return context.log(err);
                context.log('valence file deleted successfully');
                fs.readFile(`${filename}-arousal.txt`, 'utf8', function (err, data) {
                    if (err) throw err;
                    context.log("arousal: " + data);
                    arousal = data;
                    fs.unlink(`${filename}-arousal.txt`, function (err) {
                        if (err) return context.log(err);
                        context.log('arousal file deleted successfully');
                        context.res = {
                            body: {
                                "analyzedFragments": {
                                    "fragment": [{
                                        "id": filename,
                                        "source": url,
                                        "filetype": filetype,
                                        "results": {
                                            "valence": valence,
                                            "arousal": arousal
                                        }
                                    }]
                                }
                            }
                        };
                        context.done();
                    });
                });
            });
        });

        cleanup();


        
    }

     // Step 5: cleanup
     function cleanup(){
        fs.unlink(`${filename}-smile.log`,function(err){
            if(err) return context.log(err);
            context.log('log file deleted successfully');
       }); 
        fs.unlink(`${filename}-boaw.libsvm`, function(err){
            if(err) return context.log(err);
            context.log('libsvm file deleted successfully');
       }); 
        fs.unlink(`${filename}.wav`, function(err){
            if(err) return context.log(err);
            context.log('audio file deleted successfully');
       }); 
        fs.unlink(`${filename}-LLD.csv`, function(err){
            if(err) return context.log(err);
            context.log('CSV file deleted successfully');
       }); 
     }


    
};