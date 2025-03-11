import express from "express";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import cors from "cors";
import fetch from 'node-fetch'
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import CSV from 'fast-csv'
import {Parser} from 'json2csv'
import { Transform } from 'stream';
import mongoose from 'mongoose';
import { CONNREFUSED } from "dns";
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const mongoURI = process.env.DB_URI || "your-mongodb-uri-here";
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB Atlas"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const dataSchema = new mongoose.Schema({
        Company : { type: String, required: true },
        Website : { type: String, required: true },
        Complete_SiteMap : { type: [String], required: true },
        Insight_from_prompt: { type: String, required: true }
});

const DataModel = mongoose.model('TrajectoryData', dataSchema);

const corsOptions = {
    origin: 'http://your-ui-domain.com', // Replace with your UI's domain
    methods: 'POST', // Only allow POST requests
    allowedHeaders: 'Content-Type', // Only allow Content-Type header
  };

const app = express();

app.use(cors({ origin: "*" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_FILE = path.join(__dirname, "output.csv");

// Configure Multer for file uploads
const upload = multer({ dest: "uploads/" });

let allURLs = new Set()

const dfsCrawl = async ( {url} ) => {
    try {  
       const html = await fetch(url)
       const data = await html.text()
       const $ = cheerio.load(data)
       const links = $("a").map( (i , link) => link.attribs.href ).get()

       links.forEach( (link) =>  { 
          if(!link.includes("https") || !link.includes("http")) allURLs.add(url.slice(0 , -1) + link)
           else  allURLs.add(link)
       })
   } catch (e) {
       console.log(e)
   }   
}

const addSiteMapping = async (results) => {
    const siteMapedArray = [];

    for(const currComapny of results) {
        try {
            await dfsCrawl({url : currComapny.Website})
            const currSiteMapData = { 'Company' : currComapny['Company '] , 'Website' : currComapny.Website , 'Complete_SiteMap' : [...allURLs] }
            siteMapedArray.push(currSiteMapData)
            allURLs.clear()
        } catch (e) {
            console.log(e)
        }
    }

    return siteMapedArray
}

const addAiPromtResponses = async (results) => {
    const aiPromtAddedArray = [];

    for(const currComapny of results) {
        try {
            const stringifiedSiteMap = currComapny['Complete_SiteMap'].join(",");
            const prompt = "You are analyzing a company's online presence based on its sitemap. Below is a list of all the URLs found on the company's website:" + stringifiedSiteMap + "Based on this structure, generate a concise business insight about the company. Identify key focus areas, business priorities, and any indications of growth, investment, or technology adoption.Format the response as:- Company Overview:- Key Focus Areas:- Potential Opportunities: please stick stricly to the format and avoid any extra message"
            const resultFromGemini = await model.generateContent(prompt)
            const currAiPromptedData = { ...currComapny , "Insight_from_prompt" : resultFromGemini?.response?.candidates?.[0]?.content?.parts?.[0]?.text }
            aiPromtAddedArray.push(currAiPromptedData)
        } catch (e) {
            console.log(e)
        }
    }

    return aiPromtAddedArray
}

const addToDataBase = async (results) => {
    for(const currComapny of results) {
        const { Company , Website , Complete_SiteMap , Insight_from_prompt} = currComapny

        try {
            const existingEntry = await DataModel.findOne({ Company });

            if(existingEntry) {
               console.log("exist db")

               existingEntry.Website = Website;
               existingEntry.Complete_SiteMap = Complete_SiteMap;
               existingEntry.Insight_from_prompt = Insight_from_prompt;
               await existingEntry.save();   
            } else {
                console.log("absent db")

                const newEntry = new DataModel({ Company , Website , Complete_SiteMap ,Insight_from_prompt });
                await newEntry.save();      
            }            
        } catch (e) {
            console.log(e)
        }
    }
}

// Upload and process CSV file

app.post("/upload" , upload.single("csvFile") , (req, res) => {
    console.log(req.file)

    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
    }

    console.log("route was called")

    let results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on("data", (data) => {  return results.push(data)} )
        .on("end", async () => {
            fs.unlinkSync(req.file.path);

            results = await addSiteMapping(results);

            results = await addAiPromtResponses(results);

            await addToDataBase(results)

            const json2csvParser = new Parser();
            const _CSV = json2csvParser.parse(results)
            res.attachment("result.csv")
            res.status(200).send(_CSV)      
        })
        .on("error", (err) => res.status(500).json({ error: err.message }));
});

// Start the server
const PORT = process.env.PORT || 5000; 
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
